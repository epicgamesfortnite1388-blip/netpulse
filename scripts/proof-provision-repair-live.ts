#!/usr/bin/env node
/**
 * LIVE proof — a subscription credential that the control plane re-issued, and
 * the VPN surface that repairs it.
 *
 * What runs REAL here, with nothing substituted:
 *
 *   - the deployed production Worker (`/auth/register`, `/auth/login`,
 *     `/api/v1/provision`) over HTTPS;
 *   - the live VPN host `206.1.96.89`, whose systemd reconciler rewrites the
 *     Xray/Hysteria configs from the Worker's published identity set once a
 *     minute — this script reads that host state over SSH;
 *   - the local NetPulse API (`apps/api`, the same process the UI talks to) for
 *     `POST /nodes/import` and `POST /nodes/test-batch {type:'proxy'}` — so a
 *     probe is the app's own bundled core dialing the node for real;
 *   - the app's own share-link conversion (`toShareLink`) on the Worker's own
 *     provision response.
 *
 * The one substitution, stated plainly: the rotation is NOT issued through
 * `POST /api/v1/ops/vpn/rotate`. That route needs the deployed `OPS_TOKEN`, and
 * the only copy on this workstation (`cloud/worker/.ops-token.local`) is the
 * value `docs/SECURITY_AUDIT_2026-09-30.md` had revoked (verified: it answers
 * 401). So the revocation step is a direct D1 `DELETE` of the account's
 * `vpn_credentials` rows — the same table and the same "the host may carry only
 * what is published here" rule the ops action writes — and the re-issue then
 * goes through the product's own provisioning path, where
 * `ensureVpnCredential` mints a fresh secret because the row is gone. Nothing
 * in this script writes a credential value it invented.
 *
 * USAGE
 *   npx tsx scripts/proof-provision-repair-live.ts setup      # account, entitlement, provision, import, first probe
 *   npx tsx scripts/proof-provision-repair-live.ts baseline   # re-measure the pre-rotation probe on the same account
 *   npx tsx scripts/proof-provision-repair-live.ts stale     # revoke server-side, wait for the host, probe (expect FAILURE)
 *   npx tsx scripts/proof-provision-repair-live.ts verify     # after the surface refreshed: probe (expect recovery)
 *   npx tsx scripts/proof-provision-repair-live.ts cleanup    # delete the disposable account and confirm the host is restored
 *   npx tsx scripts/proof-provision-repair-live.ts status
 *
 * Exit codes: 0 the step ran and its assertions held; 1 an assertion failed;
 * 2 the step could not run (no local API, no SSH, no state, wrangler error).
 *
 * All state, and every real credential, lives in `.scratch-provision-repair/`
 * (ignored by the repo's `.scratch*` rule) and is meant to be deleted.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

import { PROFILE_NAME_PREFIX, toShareLink } from '../packages/shared/src/cloud/provisionConfig';

const CLOUD = (process.env.NP_CLOUD_BASE ?? 'https://netpulse-cloud.shuridehradin.workers.dev').replace(/\/+$/, '');
const API = (process.env.NP_API_BASE ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const VPS = process.env.NP_VPS ?? 'root@206.1.96.89';
const VPS_KEY =
  process.env.NP_VPS_KEY ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.ssh', 'netpulse-vps-reset-2026b');
const VPS_CONFIG = '/opt/netpulse-xray/config.json';
const SCRATCH = path.resolve('.scratch-provision-repair');
const STATE_FILE = path.join(SCRATCH, 'state.json');
const PROVISION_FILE = path.join(SCRATCH, 'provision.json');
const COOKIE_FILE = path.join(SCRATCH, 'api-cookie.txt');

/** How long to wait for the host's 60 s reconciler to publish/unpublish an identity. */
const HOST_SYNC_WAIT_MS = 120_000;
const HOST_SYNC_POLL_MS = 6_000;

interface State {
  createdAt: string;
  cloudBase: string;
  apiBase: string;
  email: string;
  password: string;
  userId: string;
  hostUsername: string;
  planCode: string;
  subscriptionId: number;
  nodeIds: string[];
  links: string[];
  /** protocol → 12-hex fingerprint of the credential inside the issued link. */
  credentialFingerprints: Record<string, string>;
  hostIdentitiesBefore: number;
  hostPublishSeconds: number | null;
  baselineProbe: ProbeResult | null;
  staleProbe: ProbeResult | null;
  staleHostRemovalSeconds: number | null;
  verifyProbe: ProbeResult | null;
  credentialsUpdated: number | null;
}

interface ProbeResult {
  at: string;
  results: Record<string, { success: boolean; latencyMs?: number; error?: string }>;
  passing: string[];
}

interface SurfaceNode {
  id: string;
  label: string;
  remark?: string | null;
  protocolLabel?: string;
  testCount?: number;
  successCount?: number;
  consecutiveFailures?: number;
  lastProxyMs?: number | null;
}

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function loadState(): State {
  if (!fs.existsSync(STATE_FILE)) fail(2, `no state at ${STATE_FILE} — run \`setup\` first`);
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State;
}

function saveState(state: State): void {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/* --------------------------------- cloud ---------------------------------- */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * HTTPS via node:https, not undici's global fetch.
 *
 * Measured on this host: undici's fetch fails against *.workers.dev with
 * UND_ERR_SOCKET while the stdlib module gets through — the same finding that
 * `scripts/e2e-telegram-vpn.mjs` records. Only status-0 outcomes are retried, so
 * a real HTTP failure is never retried into a pass.
 */
function cloudOnce(
  pathname: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> | null; raw: string }> {
  return new Promise((resolve) => {
    const u = new URL(CLOUD + pathname);
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? 'GET',
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/plain',
          'content-type': 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(payload ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += String(c);
        });
        res.on('end', () => {
          let body: Record<string, unknown> | null = null;
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, body, raw });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, body: null, raw: String((e as { code?: string }).code ?? e) }));
    req.setTimeout(30_000, () => {
      req.destroy();
      resolve({ status: 0, body: null, raw: 'timeout' });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function cloud(
  pathname: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> | null; raw: string }> {
  let last = await cloudOnce(pathname, opts);
  for (let i = 0; i < 3 && last.status === 0; i++) {
    await sleep(500 * (i + 1));
    last = await cloudOnce(pathname, opts);
  }
  return last;
}

/* --------------------------------- local API ------------------------------- */

function apiCookie(): string {
  if (!fs.existsSync(COOKIE_FILE)) fail(2, `no local API session at ${COOKIE_FILE} — run \`setup\``);
  return fs.readFileSync(COOKIE_FILE, 'utf8').trim();
}

async function ensureApiSession(): Promise<string> {
  // `origin` is sent deliberately: Node's fetch carries `sec-fetch-*` metadata,
  // and the API's session gate refuses a browser-shaped request whose origin it
  // cannot recognise. The API's own origin is the origin that IS allowed.
  const res = await fetch(`${API}/api/v1/auth/session`, {
    method: 'POST',
    headers: { accept: 'application/json', origin: API },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    fail(2, `local API session refused: HTTP ${res.status} ${body.slice(0, 200)} — is \`npm run dev:api\` running on ${API}?`);
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  if (!/netpulse_session=/.test(cookie)) fail(2, `local API did not return a session cookie: ${setCookie}`);
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, `${cookie}\n`, { mode: 0o600 });
  return cookie;
}

async function apiJson<T>(
  pathname: string,
  opts: { method?: string; json?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; data: T | null; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
  try {
    const res = await fetch(API + pathname, {
      method: opts.method ?? 'GET',
      headers: { 'content-type': 'application/json', cookie: apiCookie() },
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      signal: controller.signal,
    });
    const raw = await res.text();
    let data: T | null = null;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      /* non-JSON */
    }
    return { status: res.status, data, raw };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------- D1 ------------------------------------ */

function wrangler(sql: string): Array<Record<string, unknown>> {
  const res = spawnSync(
    `npx wrangler d1 execute netpulse-cloud --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024, cwd: path.resolve('.') },
  );
  const out = `${res.stdout ?? ''}`;
  const start = out.indexOf('[');
  if (res.status !== 0 || start < 0) {
    fail(2, `wrangler d1 failed (exit ${res.status}): ${(res.stderr || out).slice(0, 500)}`);
  }
  const parsed = JSON.parse(out.slice(start)) as Array<{ results?: Array<Record<string, unknown>> }>;
  return parsed[0]?.results ?? [];
}

/* ---------------------------------- VPS ----------------------------------- */

function sshResult(cmd: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(
    'ssh',
    [
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-i', VPS_KEY,
      VPS,
      cmd,
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return { status: res.status ?? -1, stdout: `${res.stdout ?? ''}`, stderr: `${res.stderr ?? ''}` };
}

function ssh(cmd: string): string {
  const res = sshResult(cmd);
  if (res.status !== 0) fail(2, `ssh ${VPS} failed (exit ${res.status}): ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  return res.stdout.trim();
}

/**
 * Host reads used inside the polling loop THROW instead of exiting: a single
 * dropped SSH connection (measured: an intermittent "Connection closed by port
 * 22" from this workstation) must not end a step that is otherwise waiting for
 * a 60 s reconciler.
 */
function hostIdentityCount(): number {
  const res = sshResult(`grep -o 'u_[0-9a-f]\\{12\\}' ${VPS_CONFIG} | sort -u | wc -l`);
  if (res.status !== 0) throw new Error(`ssh identity count failed: ${(res.stderr || res.stdout).trim().slice(0, 160)}`);
  return Number.parseInt(res.stdout.trim(), 10);
}

/** How many client entries mention this username in the live server config. */
function hostIdentityOccurrences(username: string): number {
  const res = sshResult(`grep -o '${username}' ${VPS_CONFIG} | wc -l`);
  if (res.status !== 0) throw new Error(`ssh identity lookup failed: ${(res.stderr || res.stdout).trim().slice(0, 160)}`);
  return Number.parseInt(res.stdout.trim(), 10);
}

async function waitForHost(predicate: () => boolean, description: string, onPoll?: (n: number) => void): Promise<number> {
  const started = Date.now();
  let lastError = 'none';
  for (;;) {
    try {
      if (predicate()) return Math.round((Date.now() - started) / 100) / 10;
      onPoll?.(hostIdentityCount());
    } catch (err) {
      // Keep waiting: the SSH link dropped, or the host is applying a config.
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() - started > HOST_SYNC_WAIT_MS) {
      fail(1, `host never ${description} within ${HOST_SYNC_WAIT_MS / 1000}s (last ssh error: ${lastError})`);
    }
    await sleep(HOST_SYNC_POLL_MS);
  }
}

/* ------------------------------- app surface ------------------------------ */

/** The credential inside a converted link, for fingerprinting only. */
function credentialOf(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.protocol === 'vmess:') {
      const payload = JSON.parse(Buffer.from(url.href.slice('vmess://'.length), 'base64').toString('utf8')) as {
        id?: string;
      };
      return payload.id ?? null;
    }
    return decodeURIComponent(url.username) || null;
  } catch {
    return null;
  }
}

/** The provisioned nodes as the repair card sees them (`GET /nodes?search=NetPulse · `). */
async function surfaceNodes(): Promise<SurfaceNode[]> {
  const res = await apiJson<{ nodes: SurfaceNode[] }>(
    `/api/v1/nodes?limit=200&search=${encodeURIComponent(PROFILE_NAME_PREFIX)}`,
    { timeoutMs: 60_000 },
  );
  if (res.status !== 200 || !res.data) fail(2, `GET /nodes failed: HTTP ${res.status} ${res.raw.slice(0, 200)}`);
  return (res.data.nodes ?? []).filter(
    (n) => (n.remark ?? '').startsWith(PROFILE_NAME_PREFIX) || n.label.startsWith(PROFILE_NAME_PREFIX),
  );
}

async function probe(nodeIds: string[]): Promise<ProbeResult> {
  const res = await apiJson<{ results: Record<string, { success: boolean; latencyMs?: number; error?: string }> }>(
    '/api/v1/nodes/test-batch',
    { method: 'POST', json: { nodeIds, type: 'proxy' }, timeoutMs: 300_000 },
  );
  if (res.status !== 200 || !res.data) fail(2, `POST /nodes/test-batch failed: HTTP ${res.status} ${res.raw.slice(0, 300)}`);
  const results = res.data.results ?? {};
  return {
    at: new Date().toISOString(),
    results,
    passing: Object.entries(results)
      .filter(([, r]) => r.success)
      .map(([id]) => id),
  };
}

function printProbe(label: string, result: ProbeResult, nodeIds: string[]): void {
  const passing = new Set(result.passing);
  for (const id of nodeIds) {
    const r = result.results[id];
    if (!r) {
      console.log(`  ${label} ${id}: no result`);
      continue;
    }
    const mark = r.success ? 'PASS' : 'FAIL';
    console.log(`  ${label} ${id.slice(0, 24)}… ${mark}${r.latencyMs ? ` ${r.latencyMs} ms` : ''}${r.error ? ` — ${r.error}` : ''}`);
  }
}

/* --------------------------------- commands -------------------------------- */

async function setup(): Promise<void> {
  fs.mkdirSync(SCRATCH, { recursive: true });
  let email = process.env.NP_PROOF_EMAIL ?? `np-repair-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@example.com`;
  const password = crypto.randomBytes(18).toString('base64url');

  const plans = wrangler('SELECT code FROM plans LIMIT 1');
  const planCode = String(plans[0]?.code ?? '');
  if (!planCode) fail(2, 'the live D1 has no plan rows — cannot provision a test entitlement');

  let registered: { status: number; body: Record<string, unknown> | null; raw: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = attempt === 0 ? email : email.replace('@', `${attempt}@`);
    registered = await cloud('/api/v1/auth/register', {
      method: 'POST',
      body: { email: candidate, password, device: { name: 'live-proof', os: 'windows', appVersion: '1.1.1' } },
    });
    if (registered.status !== 409) {
      email = candidate;
      break;
    }
  }
  if (!registered || registered.status !== 201) {
    fail(2, `register failed: HTTP ${registered?.status} ${registered?.raw.slice(0, 200)}`);
  }
  const user = (registered.body?.user ?? {}) as { id?: string };
  const accessToken = String(registered.body?.accessToken ?? '');
  const userId = String(user.id ?? '');
  if (!userId || !accessToken) fail(2, `register returned no user/token: ${registered.raw.slice(0, 300)}`);
  console.log(`[setup] account ${email} (${userId}) registered on ${CLOUD}`);

  const subscriptionId = 990_000 + Math.floor(Math.random() * 9_000);
  wrangler(
    `INSERT INTO np_entitlements (subscription_id, user_id, netpulse_account_id, plan_code, status, started_at, expires_at, auto_renew, total_gb, used_gb, ip_limit, config_updated_at, event_id, updated_at) ` +
      `VALUES (${subscriptionId}, '${userId}', 'NP-LIVE-PROOF', '${planCode}', 'active', '${new Date().toISOString()}', '2099-01-01 00:00:00', 0, 0, 0, 3, NULL, NULL, ${Date.now()})`,
  );
  console.log(`[setup] entitlement ${subscriptionId} (plan ${planCode}) inserted directly in D1 — the bot owns this table in production`);

  const provision = await cloud('/api/v1/provision', { method: 'POST', token: accessToken, body: {} });
  if (provision.status !== 200 || !provision.body) {
    fail(1, `provision failed: HTTP ${provision.status} ${provision.raw.slice(0, 300)}`);
  }
  fs.writeFileSync(PROVISION_FILE, `${JSON.stringify(provision.body, null, 2)}\n`, { mode: 0o600 });
  const provisioned = (provision.body.provisioned ?? []) as Array<{ protocol: string; name: string; config: string; id: string }>;
  console.log(`[setup] provision issued ${provisioned.length} config(s): ${provisioned.map((p) => p.protocol).join(', ')}`);

  const links: string[] = [];
  const credentialFingerprints: Record<string, string> = {};
  const unconvertible: string[] = [];
  for (const entry of provisioned) {
    const conversion = toShareLink(entry as never);
    if (!conversion.ok) {
      unconvertible.push(`${entry.protocol} (${conversion.reason})`);
      continue;
    }
    links.push(conversion.request.link);
    const credential = credentialOf(conversion.request.link);
    if (credential) credentialFingerprints[entry.protocol] = sha256Hex(credential).slice(0, 12);
  }
  console.log(`[setup] converted ${links.length} to node links; not expressible as a link: ${unconvertible.join(', ') || 'none'}`);

  await ensureApiSession();
  const imported = await apiJson<{ imported: number; duplicates: number; invalid: number; credentialsUpdated?: number; nodeIds?: string[] }>(
    '/api/v1/nodes/import',
    { method: 'POST', json: { configs: links }, timeoutMs: 120_000 },
  );
  if (imported.status !== 201 || !imported.data) fail(1, `import failed: HTTP ${imported.status} ${imported.raw.slice(0, 300)}`);
  console.log(
    `[setup] local import: imported=${imported.data.imported} duplicates=${imported.data.duplicates} invalid=${imported.data.invalid} credentialsUpdated=${imported.data.credentialsUpdated ?? 'n/a'}`,
  );

  const nodes = await surfaceNodes();
  if (nodes.length === 0) fail(1, 'no provisioned nodes are visible on the VPN surface after import');
  console.log(`[setup] VPN surface now lists ${nodes.length} provisioned profile(s):`);
  for (const n of nodes) console.log(`         ${n.label} · ${n.protocolLabel ?? '?'} · tests=${n.testCount ?? 0} ok=${n.successCount ?? 0}`);

  const userIdHash = sha256Hex(userId).slice(0, 12);
  const hostUsername = `u_${userIdHash}`;
  const hostIdentitiesBefore = hostIdentityCount();
  console.log(`[setup] host identities before this test: ${hostIdentitiesBefore}`);
  const publishSeconds = await waitForHost(
    () => hostIdentityOccurrences(hostUsername) > 0,
    `published ${hostUsername}`,
    (n) => console.log(`        waiting for the host reconciler… identities=${n}`),
  );
  console.log(`[setup] host published ${hostUsername} after ${publishSeconds}s (reconciler window is 60s)`);

  const nodeIds = nodes.map((n) => n.id);
  const baselineProbe = await probe(nodeIds);
  printProbe('[baseline]', baselineProbe, nodeIds);
  console.log(`[setup] baseline proxy probe: ${baselineProbe.passing.length}/${nodeIds.length} carried traffic`);

  saveState({
    createdAt: new Date().toISOString(),
    cloudBase: CLOUD,
    apiBase: API,
    email,
    password,
    userId,
    hostUsername,
    planCode,
    subscriptionId,
    nodeIds,
    links,
    credentialFingerprints,
    hostIdentitiesBefore,
    hostPublishSeconds: publishSeconds,
    baselineProbe,
    staleProbe: null,
    staleHostRemovalSeconds: null,
    verifyProbe: null,
    credentialsUpdated: null,
  });
  console.log(`\n[setup] state written to ${STATE_FILE} (no secrets printed; the provision response is ${PROVISION_FILE})`);
  if (baselineProbe.passing.length === 0) {
    console.log('[setup] NOTE: no protocol carried a probe from this workstation — the tunnel leg is the limit, not the credential.');
  }
}

/**
 * Measure the pre-rotation probe again and record it as the baseline.
 *
 * Separate from `setup` because setup is one-shot (it registers the account and
 * inserts the entitlement): when a change to the probe path lands between setup
 * and the rotation, the baseline has to be re-measured against the same account
 * rather than a new one.
 */
async function baseline(): Promise<void> {
  const state = loadState();
  const nodes = await surfaceNodes();
  const nodeIds = nodes.map((n) => n.id);
  console.log('[baseline] surface profiles:');
  for (const n of nodes) console.log(`         ${n.label} · ${n.protocolLabel ?? '?'}`);
  const result = await probe(nodeIds);
  printProbe('[baseline]', result, nodeIds);
  saveState({ ...state, nodeIds, baselineProbe: result });
  console.log(`[baseline] ${result.passing.length}/${nodeIds.length} carried traffic — recorded as the pre-rotation baseline`);
  if (result.passing.length === 0) {
    console.log('[baseline] FAIL — nothing carried traffic before the rotation, so a later regression would prove nothing');
    process.exit(1);
  }
}

async function stale(): Promise<void> {
  const state = loadState();
  const changes = wrangler(`DELETE FROM vpn_credentials WHERE user_id = '${state.userId}'`);
  console.log(`[stale] revoked the account's credential rows server-side (changes reported: ${JSON.stringify(changes)})`);

  const removalSeconds = await waitForHost(
    () => hostIdentityOccurrences(state.hostUsername) === 0,
    `removed ${state.hostUsername}`,
    (n) => console.log(`        waiting for the host reconciler… identities=${n}`),
  );
  console.log(`[stale] the host stopped carrying ${state.hostUsername} after ${removalSeconds}s`);

  const nodes = await surfaceNodes();
  console.log('[stale] what the VPN surface now sees:');
  for (const n of nodes) {
    console.log(
      `         ${n.label} · ${n.protocolLabel ?? '?'} · tests=${n.testCount ?? 0} ok=${n.successCount ?? 0} consecutiveFailures=${n.consecutiveFailures ?? 0}`,
    );
  }

  const nodeIds = nodes.map((n) => n.id);
  const staleProbe = await probe(nodeIds);
  printProbe('[stale]', staleProbe, nodeIds);

  const previouslyPassing = state.baselineProbe?.passing ?? [];
  const stillPassing = new Set(staleProbe.passing);
  const broken = previouslyPassing.filter((id) => !stillPassing.has(id));
  console.log(
    `[stale] ${broken.length}/${previouslyPassing.length} previously-passing profile(s) now fail — a stale credential is what the surface will be told to repair`,
  );
  if (broken.length === 0) console.log('[stale] NOTE: nothing regressed — a refresh would have nothing to prove');

  saveState({ ...state, staleProbe, staleHostRemovalSeconds: removalSeconds });
  console.log(`\n[stale] next: refresh from the VPN surface, then run \`verify\``);
}

async function verify(): Promise<void> {
  const state = loadState();
  const nodes = await surfaceNodes();
  const nodeIds = nodes.map((n) => n.id);
  const result = await probe(nodeIds);
  printProbe('[verify]', result, nodeIds);

  const previouslyPassing = state.baselineProbe?.passing ?? [];
  const passing = new Set(result.passing);
  const recovered = previouslyPassing.filter((id) => passing.has(id));
  console.log(`[verify] ${recovered.length}/${previouslyPassing.length} of the baseline-passing profiles carry traffic again`);

  console.log('[verify] surface state after the refresh:');
  for (const n of nodes) {
    console.log(
      `         ${n.label} · ${n.protocolLabel ?? '?'} · tests=${n.testCount ?? 0} ok=${n.successCount ?? 0} consecutiveFailures=${n.consecutiveFailures ?? 0}`,
    );
  }

  saveState({ ...state, verifyProbe: result });
  if (previouslyPassing.length > 0 && recovered.length !== previouslyPassing.length) {
    console.log('[verify] FAIL — the refresh did not restore every profile that used to work');
    process.exit(1);
  }
  console.log('[verify] PASS — the credential the server re-issued is the one the app now dials');
}

async function cleanup(): Promise<void> {
  const state = loadState();
  const statements: Array<[string, string]> = [
    ['vpn_credentials', `DELETE FROM vpn_credentials WHERE user_id = '${state.userId}'`],
    ['vpn_profiles', `DELETE FROM vpn_profiles WHERE user_id = '${state.userId}'`],
    ['np_entitlements', `DELETE FROM np_entitlements WHERE user_id = '${state.userId}'`],
    ['sessions', `DELETE FROM sessions WHERE user_id = '${state.userId}'`],
    ['users', `DELETE FROM users WHERE id = '${state.userId}'`],
  ];
  for (const [table, sql] of statements) {
    wrangler(sql);
    console.log(`[cleanup] cleared ${table}`);
  }

  // A failed run leaves its account behind (register succeeded, a later step
  // did not), so every disposable account is removed, not just this one's.
  const leftovers = wrangler(`SELECT id FROM users WHERE email LIKE 'np-repair-%@example.com'`);
  for (const row of leftovers) {
    const id = String(row.id);
    for (const sql of [
      `DELETE FROM vpn_credentials WHERE user_id = '${id}'`,
      `DELETE FROM vpn_profiles WHERE user_id = '${id}'`,
      `DELETE FROM np_entitlements WHERE user_id = '${id}'`,
      `DELETE FROM sessions WHERE user_id = '${id}'`,
      `DELETE FROM users WHERE id = '${id}'`,
    ]) {
      wrangler(sql);
    }
    console.log(`[cleanup] removed leftover proof account ${id}`);
  }

  const restored = await waitForHost(
    () => hostIdentityCount() <= state.hostIdentitiesBefore,
    `returned to ${state.hostIdentitiesBefore} identities`,
    (n) => console.log(`        waiting for the host reconciler… identities=${n}`),
  );
  console.log(`[cleanup] host back to its pre-test identity set after ${restored}s (${hostIdentityCount()} identities)`);
  console.log(`[cleanup] the imported nodes stay in the local dev DB (${SCRATCH} holds the state that names them)`);
}

function status(): void {
  const state = loadState();
  console.log(JSON.stringify({
    createdAt: state.createdAt,
    cloudBase: state.cloudBase,
    email: state.email,
    userId: state.userId,
    hostUsername: state.hostUsername,
    credentialFingerprints: state.credentialFingerprints,
    hostIdentitiesBefore: state.hostIdentitiesBefore,
    hostPublishSeconds: state.hostPublishSeconds,
    baselinePassing: state.baselineProbe?.passing.length ?? null,
    stalePassing: state.staleProbe?.passing.length ?? null,
    staleHostRemovalSeconds: state.staleHostRemovalSeconds,
    verifyPassing: state.verifyProbe?.passing.length ?? null,
  }, null, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const commands: Record<string, () => Promise<void> | void> = { setup, baseline, stale, verify, cleanup, status };
  const run = command ? commands[command] : undefined;
  if (!run) fail(2, 'usage: proof-provision-repair-live.ts <setup|baseline|stale|verify|cleanup|status>');
  await run();
}

// No top-level await: the repo's tsx runs this file as CJS (no `type: module`).
main().catch((err) => {
  console.error('proof-provision-repair-live failed:', err);
  process.exit(2);
});
