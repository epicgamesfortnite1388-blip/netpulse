import { capture } from './capture.mjs';
import { osFetchThroughProxy } from './os-fetch.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const VPROOT = 'C:/Users/RADIN/AppData/Local/Temp/netpulse-vpnproof';
const EV = join(VPROOT, 'evidence', 'g4');
mkdirSync(EV, { recursive: true });

const bootPath = join(VPROOT, 'evidence', 'g4-boot.json');
if (!existsSync(bootPath)) throw new Error('missing boot file: ' + bootPath);
const boot = JSON.parse(readFileSync(bootPath, 'utf8'));
const token = boot.token;
const api_base = boot.api_base;
if (!api_base || !api_base.startsWith('http')) throw new Error('bad api_base: ' + JSON.stringify(api_base));
console.log('boot ok: api_base=' + api_base + ' tokenLen=' + token.length);

function encId(id) { return id.replace(/:/g, '%3A'); }

async function apiPost(pathSuffix, body) {
  const url = api_base.replace(/\/$/, '') + '/' + pathSuffix.replace(/^\//, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: resp.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function apiGet(pathSuffix) {
  const url = api_base.replace(/\/$/, '') + '/' + pathSuffix.replace(/^\//, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + token },
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: resp.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForTest(nodeId, label) {
  const enc = encId(nodeId);
  let lastBody = null;
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const ns = await apiGet(`nodes/${enc}`);
    lastBody = ns.body;
    const s = ns.body;
    console.log(`  poll ${i}: status=${s.status} median=${s.medianProxyMs} succ=${s.recentSuccessCount} fail=${s.recentFailureCount} loss=${s.recentLossPct}% error=${s.error ?? 'none'}`);
    if (s.medianProxyMs != null && s.lastSuccessAt != null) {
      console.log(`  ${label} test SUCCEEDED at poll ${i}: median=${s.medianProxyMs}ms lastSuccess=${s.lastSuccessAt}`);
      return s;
    }
    if (s.status === 'failed' && s.error && s.error.toLowerCase().includes('refused')) {
      console.log('  test failed with connection refused — proof server may not be reachable');
      throw new Error(`${label} test failed (connection refused): ${JSON.stringify(s)}`);
    }
  }
  throw new Error(`${label} test did not complete; last state: ${JSON.stringify(lastBody)}`);
}

async function main() {
  const log = [];
  const note = (step, extra) => {
    const entry = { step, at: Date.now(), ...extra };
    log.push(entry);
    console.log(`[${step}]`, JSON.stringify(extra).slice(0, 160));
  };

  // ---- STEP 0: baseline ----
  console.log('=== STEP 0: baseline ===');
  const b = await capture('00-baseline');
  const baselineState = b.tunnel?.state ?? 'unknown';
  console.log('  baseline state:', baselineState, 'proxyEnable:', b.registry?.proxyEnable, 'xrayProcs:', b.xrayProcs?.length);
  if (baselineState !== 'down') throw new Error(`baseline not down: ${JSON.stringify(b.tunnel)}`);
  note('baseline', { state: baselineState, proxyEnable: b.registry?.proxyEnable, ports: b.listeningPorts?.length, xrayProcs: b.xrayProcs?.length });

  // ---- STEP 1: import proof-a + proof-b ----
  console.log('=== STEP 1: import proof nodes ===');
  const UUID_A = '11111111-2222-4333-8444-555555555555';
  const UUID_B = '99999999-8888-4777-8666-555555555555';
  const LINK_A = `vless://${UUID_A}@localhost:20801#proof-a`;
  const LINK_B = `vless://${UUID_B}@localhost:20802#proof-b`;
  const imp = await apiPost('nodes/import', { configs: [LINK_A, LINK_B] });
  console.log('  import result:', JSON.stringify(imp.body));
  note('import', { imported: imp.body.imported, duplicates: imp.body.duplicates, invalid: imp.body.invalid, nodeIds: imp.body.nodeIds });
  // Import returns duplicates for already-existing nodes; the nodeIds array
  // is the deduped set. Walk it to find two distinct healthy nodes.
  const seen = new Set();
  const candidates = [];
  for (const id of imp.body.nodeIds) {
    if (!seen.has(id)) { seen.add(id); candidates.push(id); }
  }
  console.log('  deduped candidates:', candidates);
  if (candidates.length < 2) throw new Error(`not enough distinct nodes: ${JSON.stringify(imp.body)}`);
  const nodeA = candidates[0];
  const nodeB = candidates[1];

  // ---- STEP 1b: test proof-a ----
  console.log('=== STEP 1b: test proof-a ===');
  const testRes = await apiPost(`nodes/${encId(nodeA)}/test`, { nodeId: nodeA, type: 'proxy' });
  console.log('  test start status:', testRes.status, 'body:', JSON.stringify(testRes.body).slice(0, 300));
  note('test-start', { nodeId: nodeA, status: testRes.status, testBody: testRes.body });
  const pollA = await waitForTest(nodeA, 'proof-a');
  note('test-done', { nodeId: nodeA, medianProxyMs: pollA.medianProxyMs, lastSuccessAt: pollA.lastSuccessAt });

  // ---- STEP 1c: test proof-b ----
  console.log('=== STEP 1c: test proof-b ===');
  const testResB = await apiPost(`nodes/${encId(nodeB)}/test`, { nodeId: nodeB, type: 'proxy' });
  console.log('  test-b start status:', testResB.status, 'body:', JSON.stringify(testResB.body).slice(0, 300));
  const pollB = await waitForTest(nodeB, 'proof-b');
  note('test-b-done', { nodeId: nodeB, medianProxyMs: pollB.medianProxyMs });

  // ---- STEP 1d: retest proof-a to clear the recent-failure skew ----
  console.log('=== STEP 1d: retest proof-a to clear recent-failure skew ===');
  await new Promise(r => setTimeout(r, 3000));
  const retestA = await apiPost(`nodes/${encId(nodeA)}/test`, { nodeId: nodeA, type: 'proxy' });
  console.log('  retest start status:', retestA.status);
  const pollA2 = await waitForTest(nodeA, 'proof-a-retest');
  console.log('  proof-a retest median:', pollA2.medianProxyMs, 'lastSuccess:', pollA2.lastSuccessAt);

  // ---- STEP 2: connect proof-a ----
  console.log('=== STEP 2: connect proof-a ===');
  // Re-fetch nodeA to confirm it still looks tunnelable after the test.
  const nodeACheck = await apiGet(`nodes/${encId(nodeA)}`);
  console.log('  nodeA pre-connect check:', JSON.stringify({ status: nodeACheck.body.status, medianProxyMs: nodeACheck.body.medianProxyMs, lastSuccessAt: nodeACheck.body.lastSuccessAt, recentSuccessCount: nodeACheck.body.recentSuccessCount, recentFailureCount: nodeACheck.body.recentFailureCount }));
  const startA = await apiPost('vpn/tunnel/start', {
    nodeId: nodeA,
    systemProxy: true,
    mode: 'single',
  });
  console.log('  connect start status:', startA.status, 'body:', JSON.stringify(startA.body).slice(0, 400));
  note('connect-start', { nodeId: nodeA, status: startA.status, tunnelState: startA.body?.tunnel?.state });
  if (startA.status !== 200) {
    console.log('  connect start FAILED — dumping body for diagnosis:', JSON.stringify(startA.body));
    throw new Error(`connect start failed (status ${startA.status}): ${JSON.stringify(startA.body)}`);
  }
  if (startA.body?.tunnel?.state !== 'active') throw new Error(`tunnel not active after start: ${JSON.stringify(startA.body.tunnel)}`);

  // ---- STEP 3: verify tunnel active + OS fetch ----
  console.log('=== STEP 3: verify tunnel active ===');
  const t1 = (await apiGet('vpn/tunnel/status')).body.tunnel;
  console.log('  tunnel status:', JSON.stringify(t1).slice(0, 400));
  note('verify-active', {
    state: t1.state, nodeId: t1.nodeId, nodeName: t1.nodeName,
    systemProxy: t1.systemProxy, mode: t1.mode, inboundPort: t1.inboundPort,
    publicIp: t1.publicIp, exitIp: t1.exitIp, rxBytes: t1.rxBytes, txBytes: t1.txBytes,
    verifiedAt: t1.verifiedAt, startedAt: t1.startedAt, error: t1.error,
  });
  if (t1.state !== 'active') throw new Error(`tunnel not active: ${JSON.stringify(t1)}`);
  if (!t1.nodeId || t1.nodeId !== nodeA) throw new Error(`wrong node active: ${t1.nodeId} vs ${nodeA}`);
  if (!t1.inboundPort) throw new Error(`no inboundPort after connect: ${JSON.stringify(t1)}`);
  const osFetch1 = await osFetchThroughProxy(api_base.replace(/\/$/, '') + '/meta', 'GET');
  note('os-fetch', { status: osFetch1.status, bodySize: osFetch1.body?.length, ip: t1.publicIp });

  // ---- STEP 5: switch node mid-session ----
  console.log('=== STEP 5: switch node mid-session ===');
  const stop1 = await apiPost('vpn/tunnel/stop');
  console.log('  stop status:', stop1.status, 'body state:', stop1.body?.tunnel?.state);
  note('switch-stop-a', { status: stop1.status, tunnelState: stop1.body?.tunnel?.state });

  const startB = await apiPost('vpn/tunnel/start', {
    nodeId: nodeB,
    systemProxy: true,
    mode: 'single',
  });
  console.log('  start-b status:', startB.status, 'body state:', startB.body?.tunnel?.state);
  note('switch-start-b', { nodeId: nodeB, status: startB.status, tunnelState: startB.body?.tunnel?.state });
  if (startB.status !== 200) throw new Error(`switch connect failed: ${JSON.stringify(startB.body)}`);
  if (startB.body?.tunnel?.state !== 'active') throw new Error(`tunnel not active after switch: ${JSON.stringify(startB.body.tunnel)}`);

  const t2 = (await apiGet('vpn/tunnel/status')).body.tunnel;
  console.log('  tunnel status after switch:', JSON.stringify(t2).slice(0, 300));
  note('verify-switched', {
    state: t2.state, nodeId: t2.nodeId, nodeName: t2.nodeName,
    systemProxy: t2.systemProxy, publicIp: t2.publicIp,
  });
  if (t2.state !== 'active') throw new Error(`tunnel not active after switch: ${JSON.stringify(t2)}`);
  if (!t2.nodeId || t2.nodeId !== nodeB) throw new Error(`wrong node after switch: ${t2.nodeId} vs ${nodeB}`);
  const osFetch2 = await osFetchThroughProxy(api_base.replace(/\/$/, '') + '/meta', 'GET');
  note('os-fetch-switched', { status: osFetch2.status, bodySize: osFetch2.body?.length, ip: t2.publicIp });

  // ---- STEP 7: deliberate disconnect ----
  console.log('=== STEP 7: deliberate disconnect ===');
  const disconnect = await apiPost('vpn/disconnect');
  console.log('  disconnect status:', disconnect.status, 'body:', JSON.stringify(disconnect.body).slice(0, 300));
  note('disconnect', { status: disconnect.status, body: disconnect.body });

  const t3 = (await apiGet('vpn/tunnel/status')).body.tunnel;
  console.log('  tunnel status after disconnect:', JSON.stringify(t3).slice(0, 400));
  note('verify-disconnected', { state: t3.state, nodeId: t3.nodeId, inboundPort: t3.inboundPort, systemProxy: t3.systemProxy, error: t3.error });
  if (t3.state !== 'idle') throw new Error(`tunnel not idle after disconnect: ${JSON.stringify(t3)}`);

  // ---- STEP 8: final capture ----
  console.log('=== STEP 8: final capture ===');
  const f = await capture('08-final');
  console.log('  final capture tunnel:', JSON.stringify(f.tunnel).slice(0, 300));
  note('final', {
    state: f.tunnel?.state ?? f.state,
    proxyEnable: f.registry?.proxyEnable,
    ports: f.listeningPorts?.length ?? f.listeningPorts?.length,
    xrayProcs: f.xrayProcs?.length ?? f.xrayProcs?.length,
    relayEvents: f.relayEvents,
  });

  // ---- WRITE EVIDENCE ----
  const evidence = { timestamp: Date.now(), token, bootId: boot.bootId, log };
  writeFileSync(join(EV, 'g4-lifecycle.json'), JSON.stringify(evidence, null, 2));
  console.log('=== G4 LIFECYCLE PROOF COMPLETE ===');
  console.log('  evidence written to', join(EV, 'g4-lifecycle.json'));
}

main().catch(err => {
  console.error('G4 driver failed:', err);
  writeFileSync(join(EV, 'g4-lifecycle-failed.json'), JSON.stringify({
    timestamp: Date.now(),
    error: err instanceof Error ? err.stack : String(err),
    log,
  }, null, 2));
  process.exit(1);
});
