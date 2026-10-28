import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const VPS = '206.1.96.89';
const TIMEOUT = 10_000;

function checkTcp(port: number, host = VPS): Promise<{ port: number; ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const socket = new http.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve({ port, ok: false, detail: 'timeout' }); }, TIMEOUT);
    socket.connect(port, host, () => { clearTimeout(timer); socket.destroy(); resolve({ port, ok: true, detail: 'open' }); });
    socket.on('error', (err) => { clearTimeout(timer); resolve({ port, ok: false, detail: err.message }); });
  });
}

function checkTls(port: number, servername: string, host = VPS): Promise<{ port: number; ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const socket = tls.connect(port, host, { servername, timeout: TIMEOUT }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve({ port, ok: true, detail: `subject=${cert.subject.CN} issuer=${cert.issuer.CN}` });
    });
    socket.on('error', (err) => resolve({ port, ok: false, detail: err.message }));
    socket.on('timeout', () => { socket.destroy(); resolve({ port, ok: false, detail: 'timeout' }); });
  });
}

async function checkHttp(port: number, path: string, host = VPS, isHttps = false): Promise<{ port: number; path: string; ok: boolean; status?: number; body?: string; detail?: string }> {
  return new Promise((resolve) => {
    const mod = isHttps ? https : http;
    const req = mod.request({ host, port, path, method: 'GET', timeout: TIMEOUT }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ port, path, ok: res.statusCode < 500, status: res.statusCode, body: body.slice(0, 200) });
      });
    });
    req.on('error', (err) => resolve({ port, path, ok: false, detail: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ port, path, ok: false, detail: 'timeout' }); });
    req.end();
  });
}

async function main() {
  const results: Record<string, unknown> = {
    checkedAt: new Date().toISOString(),
    vps: VPS,
    tcp: [] as ReturnType<typeof checkTcp>[],
    tls: [] as ReturnType<typeof checkTls>[],
    http: [] as ReturnType<typeof checkHttp>[],
  };

  const tcpPorts = [443, 2053, 2087, 8388, 8443, 53];
  for (const port of tcpPorts) {
    results.tcp.push(await checkTcp(port));
  }

  results.tls.push(await checkTls(443, 'www.microsoft.com'));
  results.tls.push(await checkTls(2053, '206-1-96-89.sslip.io'));
  results.tls.push(await checkTls(2087, '206-1-96-89.sslip.io'));

  results.http.push(await checkHttp(2053, '/np-vless', VPS, true));
  results.http.push(await checkHttp(8443, '/np-vmess', VPS, false));

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
