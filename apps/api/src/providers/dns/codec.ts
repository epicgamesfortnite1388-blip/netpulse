/**
 * Minimal DNS wire-format codec (RFC 1035 + EDNS0 RFC 6891).
 * Shared by the UDP resolver and DoH transport — no dependencies.
 *
 * Supports: header encode/decode, question encode, resource-record decode
 * with name compression (RFC 1035 §4.1.4), A/AAAA/TXT/PTR/CNAME/NS/OPT.
 */

export const DnsType = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  OPT: 41,
  SPF: 99,
} as const;

export const DnsClass = { IN: 1, CH: 3, ANY: 255 } as const;

export const Rcode = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
} as const;

export interface DnsResourceRecord {
  name: string;
  type: number;
  klass: number;
  ttl: number;
  /** decoded value for known types; raw hex otherwise */
  data: string | null;
  /** TXT strings concatenated; only for TXT */
  txt?: string[];
  /** OPT records only: DNSSEC OK extended flag */
  dnssecOk?: boolean;
}

export interface DnsResponse {
  id: number;
  rcode: number;
  /** authoritative answer flag (AA): the responding server owns the zone */
  aa: boolean;
  /** authentic-data flag (AD): DNSSEC validation was applied */
  ad: boolean;
  /** DNSSEC OK advertised in the OPT record */
  dnssecOk: boolean;
  answers: DnsResourceRecord[];
  authorities: DnsResourceRecord[];
  /** response payload size in bytes */
  size: number;
}

export function encodeDnsQuery(
  id: number,
  qname: string,
  qtype: number,
  opts: { klass?: number; edns?: boolean; dnssecOk?: boolean } = {},
): Buffer {
  const klass = opts.klass ?? DnsClass.IN;
  const labels = qname
    .replace(/\.$/, '')
    .split('.')
    .map((label) => {
      if (!label.length || label.length > 63) throw new Error(`invalid DNS label "${label}"`);
      return label;
    });

  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0x0100, 2); // RD=1
  header.writeUInt16BE(1, 4); // QDCOUNT=1
  parts.push(header);

  for (const label of labels) {
    const len = Buffer.alloc(1);
    len.writeUInt8(label.length, 0);
    parts.push(len, Buffer.from(label, 'ascii'));
  }
  parts.push(Buffer.from([0x00])); // root

  const q = Buffer.alloc(4);
  q.writeUInt16BE(qtype, 0);
  q.writeUInt16BE(klass, 2);
  parts.push(q);

  if (opts.edns) {
    // OPT pseudo-RR: root name, type 41, class = UDP payload size (4096),
    // TTL field = extended flags — DO bit = 0x8000
    const opt = Buffer.alloc(10);
    opt.writeUInt16BE(DnsType.OPT, 0);
    opt.writeUInt16BE(4096, 2); // class field = UDP size
    opt.writeUInt32BE(opts.dnssecOk ? 0x00008000 : 0, 4); // TTL field = extended flags
    opt.writeUInt16BE(0, 8); // RDLENGTH = 0
    parts.push(Buffer.from([0x00])); // root name for the OPT record
    parts.push(opt);
  }

  return Buffer.concat(parts);
}

function decodeName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let jumped = false;
  let next = offset;
  let guard = 0;
  let ptr = offset;

  while (guard++ < 64) {
    const len = buf.readUInt8(ptr);
    if (len === 0) {
      if (!jumped) next = ptr + 1;
      break;
    }
    // pointer (top two bits set)
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) next = ptr + 2;
      jumped = true;
      ptr = ((len & 0x3f) << 8) | buf.readUInt8(ptr + 1);
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error('bad label type');
    labels.push(buf.toString('ascii', ptr + 1, ptr + 1 + len));
    ptr += 1 + len;
  }

  return { name: labels.join('.') || '.', next };
}

function decodeRData(
  buf: Buffer,
  type: number,
  start: number,
  rdlength: number,
): { data: string | null; txt?: string[] } {
  switch (type) {
    case DnsType.A: {
      if (rdlength !== 4) return { data: null };
      return { data: [...Array(4)].map((_, i) => String(buf[start + i])).join('.') };
    }
    case DnsType.AAAA: {
      if (rdlength !== 16) return { data: null };
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(start + i).toString(16));
      return { data: groups.join(':') };
    }
    case DnsType.TXT:
    case DnsType.SPF: {
      const strings: string[] = [];
      let p = start;
      const end = start + rdlength;
      while (p < end) {
        const len = buf.readUInt8(p);
        strings.push(buf.toString('utf8', p + 1, p + 1 + len));
        p += 1 + len;
      }
      return { data: strings.join(''), txt: strings };
    }
    case DnsType.PTR:
    case DnsType.CNAME:
    case DnsType.NS: {
      const { name } = decodeName(buf, start);
      return { data: name };
    }
    default:
      return { data: buf.toString('hex', start, start + rdlength) };
  }
}

function decodeSection(
  buf: Buffer,
  offset: number,
  count: number,
): { records: DnsResourceRecord[]; next: number } {
  const records: DnsResourceRecord[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    const { name, next } = decodeName(buf, p);
    p = next;
    const type = buf.readUInt16BE(p);
    const klass = buf.readUInt16BE(p + 2);
    const ttl = buf.readUInt32BE(p + 4);
    const rdlength = buf.readUInt16BE(p + 8);
    p += 10;
    if (type === DnsType.OPT) {
      // OPT: ttl field carries extended flags — DO bit = 0x8000
      records.push({ name, type, klass, ttl, data: null, dnssecOk: (ttl & 0x8000) !== 0 });
    } else {
      const { data, txt } = decodeRData(buf, type, p, rdlength);
      records.push({ name, type, klass, ttl, data, txt });
    }
    p += rdlength;
  }
  return { records, next: p };
}

export function decodeDnsResponse(buf: Buffer): DnsResponse {
  if (buf.length < 12) throw new Error('truncated DNS message');
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  const nscount = buf.readUInt16BE(8);

  const rcode = flags & 0x000f;
  const aa = (flags & 0x0400) !== 0;
  const ad = (flags & 0x0020) !== 0;

  let p = 12;
  // skip questions
  for (let i = 0; i < qdcount; i++) {
    const { next } = decodeName(buf, p);
    p = next + 4; // qtype + qclass
  }

  const answers = decodeSection(buf, p, ancount);
  const authorities = decodeSection(buf, answers.next, nscount);

  // scan the additional section for the OPT record (DNSSEC OK flag)
  let dnssecOk = false;
  try {
    const arcount = buf.readUInt16BE(10);
    const additional = decodeSection(buf, authorities.next, arcount);
    dnssecOk = additional.records.some((r) => r.type === DnsType.OPT && r.dnssecOk === true);
  } catch {
    // OPT parsing is best-effort; the message body is still usable
  }

  return { id, rcode, aa, ad, dnssecOk, answers: answers.records, authorities: authorities.records, size: buf.length };
}
