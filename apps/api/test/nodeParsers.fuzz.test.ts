import { describe, expect, it } from 'vitest';

import {
  canonicalizeIpv6,
  parseHttpUri,
  parseNodeUri,
} from '../src/services/nodeParsers';

/**
 * VPN configuration fuzz harness (audit §9).
 *
 * The parser is the app's front door for HOSTILE input: every imported node
 * config, subscription line and pasted link goes through here. The contract
 * under test is fail-safe, not "parses everything":
 *
 *   - no input may throw out of parseNodeUri / parseHttpUri (a crash or an
 *     unhandled rejection in the import pipeline is a vulnerability, not a
 *     validation failure),
 *   - a host that emerges must be name-shaped or a public IP (the private/
 *     loopback refusal lives in validateNodeHost and must hold under fuzzing),
 *   - no hostile JSON shape may pollute Object.prototype,
 *   - output size stays bounded for unbounded input (no memory bomb),
 *   - huge/absurd volumes complete (no hang) — the loop below runs thousands
 *     of adversarial inputs in well under a test budget.
 */

/** Deterministic adversarial corpus — every category from the audit brief. */
function hostileInputs(): string[] {
  const long = (n: number, ch = 'A'): string => ch.repeat(n);
  // deeply nested object for the vmess JSON path. Depth is capped where
  // JSON.stringify ITSELF overflows (verified live: ~5k levels throws
  // RangeError inside the generator — a stack-bomb payload must come to the
  // parser pre-serialized, not be built recursively here). The parser-side
  // depth defense is still exercised: JSON.parse of the resulting string
  // faces the same deep nesting.
  let deep: unknown = { add: 'example.com', port: 443, id: 'u' };
  for (let i = 0; i < 500; i++) deep = { a: deep };
  const list: string[] = [
    // empty / whitespace / separator noise
    '', ' ', '\n', '\t', '///', '://', '?', '#', '&', '=',
    // shell-ish and metachar payloads (must remain inert DATA, never syntax)
    'vless://x;id=1', 'vless://$(calc)', 'vless://`cmd`', 'vless://a|b',
    'vless://a&&b', 'vless://a>out', 'vless://../../etc/passwd',
    'vless://%00%0d%0aX-Injected:%201', 'vless://a\\..\\..\\win',
    // traversal-shaped, URL-encoded and double-encoded
    'vmess://Li4vLi4vY29uZmln',
    'trojan://x@..%2f..%2fetc%2fpasswd:443',
    // malformed base64 (vmess body)
    'vmess://!!!!', 'vmess://====', 'vmess://A', 'vmess://AQ==Q==',
    'vmess://' + long(10_000, '='),
    // malformed JSON after valid base64
    `vmess://${Buffer.from('{not json').toString('base64')}`,
    `vmess://${Buffer.from('[1,2,3').toString('base64')}`,
    `vmess://${Buffer.from('"just a string"').toString('base64')}`,
    `vmess://${Buffer.from('null').toString('base64')}`,
    // unexpected field types in vmess JSON
    `vmess://${Buffer.from(JSON.stringify({ add: { nested: true }, port: { a: 1 }, id: ['array'], tls: 1 })).toString('base64')}`,
    `vmess://${Buffer.from(JSON.stringify({ add: null, port: null, id: null })).toString('base64')}`,
    `vmess://${Buffer.from(JSON.stringify({ add: 12345, port: -1, id: {} })).toString('base64')}`,
    // huge values
    `vmess://${Buffer.from(JSON.stringify({ add: long(60_000), port: 443, id: long(60_000) })).toString('base64')}`,
    `vmess://${Buffer.from(JSON.stringify({ add: 'h.com', port: Number.MAX_SAFE_INTEGER, id: 'x' })).toString('base64')}`,
    // deeply nested object (stack depth)
    `vmess://${Buffer.from(JSON.stringify(deep)).toString('base64')}`,
    // duplicate keys (last-one-wins must stay deterministic)
    `vmess://${Buffer.from('{"add":"a.example.com","add":"example.com","port":1,"port":443,"id":"x","id":"y"}').toString('base64')}`,
    // prototype-pollution shapes
    `vmess://${Buffer.from('{"__proto__":{"polluted":"yes"},"add":"example.com","port":443,"id":"u"}').toString('base64')}`,
    `vmess://${Buffer.from('{"constructor":{"prototype":{"polluted":"yes"}},"add":"example.com","port":443,"id":"u"}').toString('base64')}`,
    // invalid UTF-8 bytes inside the payload
    `vmess://${Buffer.from([0x7b, 0x22, 0x61, 0x64, 0x64, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]).toString('base64')}`,
    // extreme ports / invalid IPs / invalid IPv6 in host position
    'vless://u@[::99999]:443', 'vless://u@1.2.3.4.5:443', 'vless://u@999.1.1.1:443',
    'vless://u@1.2.3.4:99999', 'vless://u@1.2.3.4:0', 'vless://u@1.2.3.4:-5',
    'vless://u@::1:2:3:4:5:6:7:8:9:443', 'vless://u@::::', 'vless://u@[',
    // private/reserved hosts must be refused, never normalized into targets
    'vless://u@127.0.0.1:443', 'vless://u@10.0.0.5:443', 'vless://u@192.168.1.1:443',
    'vless://u@169.254.169.254:80', 'vless://u@[::1]:443', 'vless://u@[fe80::1]:443',
    'vless://u@0.0.0.0:443', 'ss://YWVzLTEyOC1nY206cHdk@127.0.0.1:8388',
    // extremely long hostname (above the 253-char DNS limit)
    `vless://u@${long(300, 'a')}.example.com:443`,
    `vless://u@${long(4_000)}.com:443`,
    // long remark/fragment and userinfo
    `vless://u@1.1.1.1:443?remarks=${encodeURIComponent(long(8_000))}`,
    `trojan://${long(2_000)}@example.com:443`,
    // unknown/other schemes must be classified, never guessed
    'http://example.com/', 'https://example.com/x', 'ssh://example.com', 'file:///etc/passwd',
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    // ssr / hysteria2 / tuic / wireguard junk shapes
    'ssr://' + long(5_000), 'ssr://???#', 'hysteria2://x?insecure=1&sni=' + long(2_000),
    'tuic://u:p@host:port?x', 'wireguard://' + long(3_000, '/'),
  ];
  return list;
}

describe('node parser fuzz (audit §9: fail-safe under hostile config)', () => {
  it('never throws for any hostile input, and returns a sane shape', () => {
    for (const input of hostileInputs()) {
      let out: ReturnType<typeof parseNodeUri>;
      expect(() => {
        out = parseNodeUri(input);
      }, `threw on: ${input.slice(0, 60)}`).not.toThrow();
      expect(out!).toHaveProperty('protocol');
      expect(out!).toHaveProperty('result');
    }
  });

  it('survives a high-volume pseudo-random corpus without hang, throw or leak', () => {
    const base = hostileInputs();
    // Deterministic mutation sweep: truncations, repetitions, byte flips.
    let seed = 0x9e3779b9;
    const rand = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const started = Date.now();
    for (let i = 0; i < 3_000; i++) {
      const src = base[rand(base.length)]!;
      const mutant = rand(4) === 0 ? src + String.fromCharCode(33 + rand(90)) : src.slice(0, rand(src.length + 1));
      let out: ReturnType<typeof parseNodeUri>;
      expect(() => {
        out = parseNodeUri(mutant);
      }).not.toThrow();
      void out;
    }
    // No hang: 3k mutants over a 950-line parser must stay in seconds.
    expect(Date.now() - started).toBeLessThan(60_000);
  });

  it('any host that emerges is name-shaped or a PUBLIC address (private refusal holds)', () => {
    for (const input of hostileInputs()) {
      const out = parseNodeUri(input);
      const result = out.result as { host?: string } | null;
      const host = result?.host;
      if (typeof host === 'string' && host.length > 0) {
        // The parser's validateNodeHost refuses private/reserved literals and
        // over-long names; a fuzz pass must never leak one through.
        expect(host.length, `over-long host escaped: ${host.slice(0, 40)}`).toBeLessThanOrEqual(253);
        expect(['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '::1', 'fe80::1', '0.0.0.0'])
          .not.toContain(host);
      }
    }
  });

  it('hostile JSON never pollutes Object.prototype', () => {
    const pollutionProbe = (): boolean =>
      ({} as Record<string, unknown>).polluted !== undefined ||
      (Object.prototype as unknown as Record<string, unknown>).polluted !== undefined;
    expect(pollutionProbe()).toBe(false);
    for (const input of hostileInputs().filter((s) => s.startsWith('vmess://'))) {
      expect(() => parseNodeUri(input)).not.toThrow();
      expect(pollutionProbe(), `polluted by: ${input.slice(0, 80)}`).toBe(false);
    }
  });

  it('output stays bounded for unbounded input (no memory bomb via one link)', () => {
    const huge = `vless://u@${'a'.repeat(100_000)}.example.com:443?sni=${'s'.repeat(100_000)}#${'r'.repeat(100_000)}`;
    const out = parseNodeUri(huge) as { result: { host?: string; sni?: string | null; remark?: string | null } | null };
    if (out.result?.host) {
      expect(out.result.host.length).toBeLessThanOrEqual(253);
    }
    if (typeof out.result?.sni === 'string') {
      expect(out.result.sni.length).toBeLessThanOrEqual(300);
    }
    if (typeof out.result?.remark === 'string') {
      expect(out.result.remark.length).toBeLessThanOrEqual(300);
    }
  });

  it('http-uri helper is equally fail-safe', () => {
    for (const input of [...hostileInputs(), 'http://', 'https://[', 'http://a b/', 'http://x:99999999']) {
      let out: ReturnType<typeof parseHttpUri>;
      expect(() => {
        out = parseHttpUri(input);
      }).not.toThrow();
      void out;
    }
  });

  it('ipv6 canonicalizer rejects the hostile shapes instead of crashing', () => {
    for (const bad of [':::', '::::', '1:2:3:4:5:6:7:8:9', '[::1]', 'gggg::1', '1::2::3', '::::ffff:1.2.3.4', `${'a'.repeat(50)}::1`]) {
      expect(() => canonicalizeIpv6(bad)).not.toThrow();
    }
  });
});
