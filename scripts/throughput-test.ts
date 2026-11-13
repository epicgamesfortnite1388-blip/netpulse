/**
 * Quick throughput test through the Aether SOCKS5 tunnel.
 * Measures download speed by fetching from a known fast endpoint through the proxy.
 */
import http from 'node:http';
import https from 'node:https';
import { SocksClient } from 'socks';

const PROXY_PORT = Number(process.argv[2] || 1819);
const TEST_URL = process.argv[3] || 'https://speed.cloudflare.com/__down?bytes=100000000'; // 100MB

async function fetchThroughSocks(url: string): Promise<{ bytes: number; ms: number }> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const port = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);
  
  return new Promise((resolve, reject) => {
    SocksClient.createConnection({
      proxy: { host: '127.0.0.1', port: PROXY_PORT, type: 5 },
      command: 'connect',
      destination: { host: parsed.hostname, port }
    }).then(({ socket }) => {
      if (isHttps) {
        const tls = require('node:tls');
        const tlsSocket = tls.connect({ socket, servername: parsed.hostname }, () => {
          const start = Date.now();
          let bytes = 0;
          tlsSocket.write(`GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.hostname}\r\nConnection: close\r\n\r\n`);
          tlsSocket.on('data', (chunk) => { bytes += chunk.length; });
          tlsSocket.on('end', () => {
            resolve({ bytes, ms: Date.now() - start });
          });
          tlsSocket.on('error', reject);
        });
        tlsSocket.on('error', reject);
      } else {
        const start = Date.now();
        let bytes = 0;
        socket.write(`GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.hostname}\r\nConnection: close\r\n\r\n`);
        socket.on('data', (chunk) => { bytes += chunk.length; });
        socket.on('end', () => {
          resolve({ bytes, ms: Date.now() - start });
        });
        socket.on('error', reject);
      }
    }).catch(reject);
  });
}

(async () => {
  try {
    console.log('Testing throughput...');
    const result = await fetchThroughSocks(TEST_URL);
    const mbps = (result.bytes * 8) / (result.ms / 1000) / 1024 / 1024;
    const report = {
      generatedAt: new Date().toISOString(),
      proxyPort: PROXY_PORT,
      url: TEST_URL,
      bytesReceived: result.bytes,
      durationMs: result.ms,
      mbps: Math.round(mbps * 100) / 100,
      mbpsRounded: Math.round(mbps)
    };
    require('fs').writeFileSync('reports/accounting/THROUGHPUT_TEST_2026-11-03.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    console.error('ERR', e);
    process.exit(1);
  }
})();
