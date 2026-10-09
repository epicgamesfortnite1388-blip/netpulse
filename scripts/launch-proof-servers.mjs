import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';

const VPR = 'C:/Users/RADIN/AppData/Local/Temp/netpulse-vpnproof';
const XR = path.join(VPR, 'cores', 'xray.exe');
const evidence = path.join(VPR, 'evidence');

// Config for proof-A (20801) and proof-B (20802)
const configs = [
  { port: 20801, uuid: '11111111-2222-4333-8444-555555555555', email: 'proof-a', name: 'g4-srvA' },
  { port: 20802, uuid: '99999999-8888-4777-8666-555555555555', email: 'proof-b', name: 'g4-srvB' },
];

// Write config files and launch each xray as a DETACHED process with stderr captured to a file
const pids = {};
for (const cfg of configs) {
  const cfgPath = path.join(evidence, cfg.name + '.json');
  const logPath = path.join(evidence, cfg.name + '-stderr.txt');
  
  const config = {
    log: { level: 'info', stderr: true },
    inbounds: [{
      port: cfg.port,
      protocol: 'vless',
      settings: { clients: [{ id: cfg.uuid, flow: '', email: cfg.email }] },
      streamSettings: { network: 'ws', wsSettings: { path: '/', headers: { Host: 'proof.localhost' } } }
    }],
    outbounds: [{ protocol: 'freedom' }],
    routing: { domainStrategy: 'AsIs' }
  };
  
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  console.log('written config for', cfg.name, 'port', cfg.port);
  
  // Open log file and keep the fd open
  const logFd = fs.openSync(logPath, 'w');
  
  // Spawn detached, with stderr going to the log fd
  const proc = spawn(XR, ['run', '-c', cfgPath], {
    detached: true,
    stdio: ['ignore', 'ignore', logFd]
  });
  proc.unref();
  pids[cfg.port] = proc.pid;
  console.log('launched', cfg.name, 'pid:', proc.pid);
  
  // Close our copy of the fd — the child keeps the underlying handle
  // But we need to keep the process alive long enough for xray to start
  // So we DON'T close the fd yet; we'll close it in the exit handler
  proc.on('exit', (code) => {
    console.log(cfg.name, 'pid', proc.pid, 'exited with code:', code);
    try { fs.closeSync(logFd); } catch {}
    // Read the log
    try {
      const logContent = fs.readFileSync(logPath, 'utf8');
      console.log(cfg.name, 'log (len', logContent.length, '):', logContent.slice(0, 500));
    } catch {}
  });
}

// Poll for both ports to be listening
console.log('\n--- polling for proof servers ---');
function pollPort(port, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      try {
        const ns = execSync('netstat -ano', { encoding: 'utf8', timeout: 3000 });
        const found = ns.split('\n').some(l => l.includes(':' + port) && l.includes('LISTENING'));
        if (found) {
          clearInterval(check);
          const line = ns.split('\n').find(l => l.includes(':' + port) && l.includes('LISTENING'));
          const m = line.match(/LISTENING\s+(\d+)/);
          resolve({ ok: true, pid: m ? m[1] : '?', line: line.trim() });
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(check);
          resolve({ ok: false, reason: 'timeout' });
        }
      } catch {}
    }, 500);
  });
}

(async () => {
  const a = await pollPort(20801);
  const b = await pollPort(20802);
  console.log('\nproof-A (20801):', a.ok ? ('LISTENING pid=' + a.pid) : ('FAILED: ' + a.reason));
  console.log('proof-B (20802):', b.ok ? ('LISTENING pid=' + b.pid) : ('FAILED: ' + b.reason));
  
  // Record pids
  fs.writeFileSync(path.join(evidence, 'g4-proof-pids.json'), JSON.stringify({
    a: pids[20801], b: pids[20802], at: Date.now()
  }, null, 2));
  
  if (!a.ok || !b.ok) {
    console.log('\nPROOF SERVERS FAILED — cannot run G4 driver');
    console.log('waiting a bit more for any late startup...');
    setTimeout(() => process.exit(1), 2000);
    return;
  }
  
  console.log('\nBOTH PROOF SERVERS UP — ready for G4 driver');
  // Keep the node process alive for a bit so the detached xrays have a chance to stabilize
  // Then exit — the xrays are detached so they'll survive
  setTimeout(() => {
    console.log('launcher exiting — xrays are detached');
    process.exit(0);
  }, 3000);
})();
