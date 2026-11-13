import { describe, expect, it } from 'vitest';

import { encodeDnsQuery, parseDnsResponse } from '../src/vpn/aetherProvider';

/**
 * DNS-in-tunnel is the fix for a measured leak, so the encoder/parser are tested
 * against a hand-built packet rather than a live resolver: a green test must mean
 * "the bytes are right", not "the network happened to answer today".
 */

/** Build an A-record response for `name` with one address, optionally compressed. */
function buildResponse(id: number, name: string, address: string, opts: { rcode?: number; compress?: boolean } = {}): Buffer {
  const labels = name.split('.');
  const qname: number[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    qname.push(bytes.length, ...bytes);
  }
  qname.push(0);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8180, 2); // QR + RD + RA, rcode 0
  header[3] = 0x80 | (opts.rcode ?? 0);
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(1, 6); // ANCOUNT

  const question = Buffer.concat([Buffer.from(qname), Buffer.from([0x00, 0x01, 0x00, 0x01])]);
  // The answer name is a pointer to offset 12 — the same compression a real
  // resolver uses, which is the part naive parsers get wrong.
  const answerName = opts.compress === false ? Buffer.from(qname) : Buffer.from([0xc0, 0x0c]);
  const tail = Buffer.alloc(10);
  tail.writeUInt16BE(1, 0); // TYPE A
  tail.writeUInt16BE(1, 2); // CLASS IN
  tail.writeUInt32BE(60, 4); // TTL
  tail.writeUInt16BE(4, 8); // RDLENGTH
  const addr = Buffer.from(address.split('.').map((n) => Number(n)));
  return Buffer.concat([header, question, answerName, tail, addr]);
}

describe('dns encoding', () => {
  it('encodes a single-question A query with the requested id', () => {
    const q = encodeDnsQuery('example.com', 0x1234);
    expect(q.readUInt16BE(0)).toBe(0x1234);
    expect(q.readUInt16BE(4)).toBe(1); // one question
    // 7"example" 3"com" 0
    expect(q.subarray(12, 25)).toEqual(Buffer.from([7, ...Buffer.from('example'), 3, ...Buffer.from('com'), 0]));
    expect(q.subarray(25)).toEqual(Buffer.from([0x00, 0x01, 0x00, 0x01]));
  });

  it('tolerates a trailing dot and refuses an over-long label', () => {
    expect(encodeDnsQuery('example.com.', 1).subarray(12, 25)).toEqual(
      Buffer.from([7, ...Buffer.from('example'), 3, ...Buffer.from('com'), 0]),
    );
    expect(() => encodeDnsQuery(`${'a'.repeat(64)}.com`, 1)).toThrow(/label too long/);
  });
});

describe('dns response parsing', () => {
  it('reads an A record behind a compression pointer', () => {
    const res = parseDnsResponse(buildResponse(7, 'api.ipify.org', '104.26.4.44'), 7);
    expect(res.rcode).toBe(0);
    expect(res.addresses).toEqual(['104.26.4.44']);
  });

  it('reads an uncompressed answer name too', () => {
    const res = parseDnsResponse(buildResponse(7, 'a.example', '1.2.3.4', { compress: false }), 7);
    expect(res.addresses).toEqual(['1.2.3.4']);
  });

  it('returns no addresses for a non-zero rcode rather than a partial answer', () => {
    const res = parseDnsResponse(buildResponse(9, 'nx.example', '0.0.0.0', { rcode: 3 }), 9);
    expect(res.rcode).toBe(3);
    expect(res.addresses).toEqual([]);
  });

  it('rejects a response whose id does not match the query', () => {
    const res = parseDnsResponse(buildResponse(11, 'example.com', '1.1.1.1'), 12);
    expect(res.id).toBe(11);
    expect(res.addresses).toEqual([]);
  });

  it('does not throw on a truncated packet', () => {
    const full = buildResponse(5, 'example.com', '1.1.1.1');
    expect(() => parseDnsResponse(full.subarray(0, 20), 5)).not.toThrow();
    expect(parseDnsResponse(Buffer.alloc(0), 5).addresses).toEqual([]);
  });
});
