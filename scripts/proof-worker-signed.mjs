import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerDist = path.resolve(__dirname, '..', 'cloud', 'worker', 'dist');
const indexPath = path.join(workerDist, 'index.js');

if (!fs.existsSync(indexPath)) {
  console.error('Worker dist not found. Run `npm run build -w @netpulse/cloud-worker` first.');
  process.exit(1);
}

const secrets = {
  AUTH_SECRET: 'dev-auth-secret',
  RESET_PEPPER: 'dev-reset-pepper',
  NETPULSE_SERVICE_SECRET: 'dev-service-secret',
  TELEGRAM_BOT_BASE_URL: 'http://127.0.0.1:9999',
  OPS_TOKEN: 'dev-ops-token',
  EXPECTED_ORIGIN: 'https://netpulse-cloud.example.workers.dev',
};

const handlerModule = await import(indexPath);
const handler = typeof handlerModule.default === 'function' ? handlerModule.default : handlerModule;

function createEnv() {
  return {
    ...secrets,
    DB: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          run() {
            return { meta: { changes: 0 } };
          },
          first() {
            return null;
          },
          all() {
            return { results: [] };
          },
        };
      },
      batch(statements) {
        return Promise.resolve();
      },
    },
  };
}

const payload = {
  eventId: `proof-${Date.now()}`,
  eventType: 'subscription.activated',
  version: 1,
  netpulseAccountId: 'np-test',
  payload: { subscription: { subscriptionId: 1, planCode: 'Pro', status: 'active', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), autoRenew: true, totalGb: 100, usedGb: 0, ipLimit: 2, configUpdatedAt: new Date().toISOString() } },
};

const body = JSON.stringify(payload);

async function makeRequest(path, method = 'GET', bodyText = '') {
  const env = createEnv();
  const url = `http://127.0.0.1:9999${path}`;
  const req = new http.request(url, { method, headers: { 'content-type': 'application/json' } }, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      console.log(`[${method} ${path}] status=${res.status} body=${data}`);
    });
  });
  req.on('error', (err) => {
    console.error(`[${method} ${path}] request error: ${err.message}`);
  });
  if (bodyText) req.write(bodyText);
  req.end();
}

async function makeSignedRequest(path, method, bodyText) {
  const env = createEnv();
  const secret = env.NETPULSE_SERVICE_SECRET;
  const timestamp = String(Date.now());
  const nonce = `nonce-${Date.now()}-${Math.random()}`;
  const signInput = `${timestamp}\n${nonce}\n${method}\n${path}\n${sha256(bodyText)}\n`;
  const signature = await sign(secret, signInput);

  const headers = {
    'x-np-timestamp': timestamp,
    'x-np-nonce': nonce,
    'x-np-signature': signature,
  };

  const url = `http://127.0.0.1:9999${path}`;
  const req = http.request(url, { method, headers }, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      console.log(`[signed ${method} ${path}] status=${res.status} body=${data}`);
    });
  });
  req.on('error', (err) => {
    console.error(`[signed ${method} ${path}] request error: ${err.message}`);
  });
  if (bodyText) req.write(bodyText);
  req.end();
}

function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  return Array.from(new Uint8Array(require('crypto').createHash('sha256').update(data).digest())).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sign(secret, input) {
  const key = await require('crypto').webcrypto.subtle.importKey('raw', Buffer.from(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await require('crypto').webcrypto.subtle.sign('HMAC', key, Buffer.from(input));
  return Buffer.from(signature).toString('base64');
}

await makeRequest('/api/v1/health');
await makeSignedRequest('/api/internal/netpulse/v1/events', 'POST', body);
await makeSignedRequest('/api/internal/netpulse/v1/events/ack', 'POST', JSON.stringify({ eventId: payload.eventId }));

console.log('Proof complete.');
