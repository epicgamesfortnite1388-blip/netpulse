import { describe, expect, it } from 'vitest';

import net from 'node:net';

import { WhitednsService, authoritativeZoneAnswer } from '../src/services/whitednsService';
import { decodeDnsResponse, DnsType } from '../src/providers/dns/codec';
import { tcpQuery } from '../src/providers/dns/resolver';
import { WhitednsErrorCode } from '@netpulse/shared';

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => noopLog,
} as unknown;

describe('WhitednsService input validation', () => {
  const service = new WhitednsService(noopLog);

  it('rejects a missing zone quickly without network', async () => {
    const started = Date.now();
    const result = await service.test({
      zone: '',
      server: '206.1.96.89',
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('error');
    expect(result.code).toBe(WhitednsErrorCode.INVALID_INPUT);
    expect(result.error).toContain('zone');
    // Input validation must fail fast, well before any network timeout.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('rejects a zone that is not a domain name', async () => {
    const result = await service.test({
      zone: 'not a domain',
      server: '206.1.96.89',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(WhitednsErrorCode.INVALID_INPUT);
    expect(result.stage).toBe('error');
  });

  it('rejects a server that is not an IPv4 address', async () => {
    const result = await service.test({
      zone: 'test.soar.abystral.dpdns.org',
      server: 'not-an-ip',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(WhitednsErrorCode.INVALID_INPUT);
    expect(result.stage).toBe('error');
  });

  it('rejects a pubkey that is not base64', async () => {
    const result = await service.test({
      zone: 'test.soar.abystral.dpdns.org',
      server: '206.1.96.89',
      pubkey: 'not-base64!!!',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(WhitednsErrorCode.INVALID_INPUT);
    expect(result.stage).toBe('error');
  });

  it('rejects an oversized zone', async () => {
    const result = await service.test({
      zone: 'a'.repeat(300),
      server: '206.1.96.89',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(WhitednsErrorCode.INVALID_INPUT);
  });

  it('does not leak local paths or secrets in error detail', async () => {
    const result = await service.test({
      zone: '',
      server: '206.1.96.89',
    });
    expect(result.error).not.toContain('/usr/local/bin');
    expect(result.error).not.toContain('soar-check');
    expect(result.error).not.toContain('/root');
    expect(result.error).not.toMatch(/[A-Za-z0-9+/]{20,}/);
  });
});

describe('authoritativeZoneAnswer', () => {
  const zone = 'gb6ysaxnm3z4r7ffwzbn5.soar.abystral.dpdns.org';
  const rr = (name: string, type: number) => ({ name, type });

  it('accepts AA=1 with NS for the exact zone', () => {
    expect(authoritativeZoneAnswer({ rcode: 0, aa: true, answers: [rr(zone, DnsType.NS)], authorities: [] }, zone).ok).toBe(true);
  });

  it('accepts AA=1 with SOA for the exact zone', () => {
    expect(authoritativeZoneAnswer({ rcode: 0, aa: true, answers: [], authorities: [rr(zone, DnsType.SOA)] }, zone).ok).toBe(true);
  });

  it('rejects a referral (AA=0) even when it has NS records', () => {
    const verdict = authoritativeZoneAnswer({ rcode: 0, aa: false, answers: [], authorities: [rr(zone, DnsType.NS)] }, zone);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('AA=0');
  });

  it('rejects an authoritative empty answer', () => {
    expect(authoritativeZoneAnswer({ rcode: 0, aa: true, answers: [], authorities: [] }, zone).ok).toBe(false);
  });

  it('accepts a parent-zone SOA but labels it non-conforming', () => {
    const parent = 'soar.abystral.dpdns.org';
    const verdict = authoritativeZoneAnswer({ rcode: 0, aa: true, answers: [], authorities: [rr(parent, DnsType.SOA)] }, zone);
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain('parent SOA');
  });

  it('rejects an unrelated authoritative SOA', () => {
    expect(authoritativeZoneAnswer({ rcode: 0, aa: true, answers: [], authorities: [rr('example.org', DnsType.SOA)] }, zone).ok).toBe(false);
  });

  it('rejects non-NOERROR responses', () => {
    expect(authoritativeZoneAnswer({ rcode: 3, aa: true, answers: [rr(zone, DnsType.NS)], authorities: [] }, zone).ok).toBe(false);
  });

  it('decodes the AA bit from the DNS header', () => {
    const buf = Buffer.alloc(12);
    buf.writeUInt16BE(0x8400, 2); // QR=1, AA=1, RCODE=0
    expect(decodeDnsResponse(buf).aa).toBe(true);
    buf.writeUInt16BE(0x8000, 2); // QR=1, AA=0
    expect(decodeDnsResponse(buf).aa).toBe(false);
  });
});

describe('tcpQuery', () => {
  it('can tunnel a DNS query through an HTTP CONNECT proxy', async () => {
    const proxy = net.createServer((client) => {
      let head = '';
      const onHead = (chunk: Buffer) => {
        head += chunk.toString('latin1');
        if (!head.includes('\r\n\r\n')) return;
        client.removeListener('data', onHead);
        expect(head.split('\r\n')[0]).toMatch(/^CONNECT 127\.0\.0\.1:53\b/);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        let buf = Buffer.alloc(0);
        client.on('data', (data: Buffer) => {
          buf = Buffer.concat([buf, data]);
          if (buf.length < 2) return;
          const len = buf.readUInt16BE(0);
          if (buf.length < 2 + len) return;
          const id = buf.readUInt16BE(2);
          const response = Buffer.alloc(12);
          response.writeUInt16BE(id, 0);
          response.writeUInt16BE(0x8400, 2);
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(response.length, 0);
          client.end(Buffer.concat([prefix, response]));
        });
      };
      client.on('data', onHead);
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = proxy.address();
      const proxyPort = typeof address === 'object' && address ? address.port : 0;
      const result = await tcpQuery('127.0.0.1', 'test.example', DnsType.NS, {
        port: 53,
        proxy: `http://127.0.0.1:${proxyPort}`,
        timeoutMs: 1_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.response?.aa).toBe(true);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('writes the RFC 1035 length prefix and accepts a matching response', async () => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 2) return;
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) return;
        const id = buf.readUInt16BE(2);
        const response = Buffer.alloc(12);
        response.writeUInt16BE(id, 0);
        response.writeUInt16BE(0x8400, 2); // QR=1, AA=1, RCODE=0
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(response.length, 0);
        socket.end(Buffer.concat([prefix, response]));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const result = await tcpQuery('127.0.0.1', 'test.example', DnsType.NS, { port, timeoutMs: 1_000 });
      expect(result.error).toBeUndefined();
      expect(result.response?.aa).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
