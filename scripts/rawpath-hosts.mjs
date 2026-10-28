/**
 * Lists the DISTINCT hosts (and ports) of a corpus file of share links, plus which
 * of them are IP literals, so the raw-ISP-path bypass routes can be computed.
 * Prints host:port only — never a credential, uuid or password.
 */
import fs from 'node:fs';
import dns from 'node:dns/promises';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tmp/rawpath-hosts.mjs <corpus.txt> [...]');
  process.exit(2);
}

const isIpv4 = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
const isIpv6 = (h) => h.includes(':');

const distinct = new Map(); // host -> Set(port)
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`${file}: MISSING`);
    continue;
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  console.log(`--- ${file} (${lines.length} entries)`);
  for (const line of lines) {
    const proto = line.split('://')[0] ?? '?';
    const m = line.match(/@([^/?#]+)/);
    if (!m) continue;
    const [host, port = ''] = m[1].split(':');
    if (!distinct.has(host)) distinct.set(host, new Set());
    distinct.get(host).add(`${proto}:${port}`);
  }
}

console.log('\n=== distinct hosts');
for (const [host, kinds] of distinct) {
  let resolved = '';
  if (!isIpv4(host) && !isIpv6(host)) {
    try {
      const a = await dns.resolve4(host);
      resolved += ` A=${a.join(',')}`;
    } catch { resolved += ' A=none'; }
    try {
      const aaaa = await dns.resolve6(host);
      resolved += ` AAAA=${aaaa.join(',')}`;
    } catch { resolved += ' AAAA=none'; }
  }
  const kind = isIpv4(host) ? 'ipv4-literal' : isIpv6(host) ? 'ipv6-literal' : 'hostname';
  console.log(`${host.padEnd(34)} ${kind.padEnd(13)} ${[...kinds].sort().join(' ')}${resolved}`);
}
