import fs from 'fs';
import path from 'path';

const VPR = 'C:/Users/RADIN/AppData/Local/Temp/netpulse-vpnproof';
const evidence = path.join(VPR, 'evidence');

const configs = [
  {
    name: 'g4-srvA-proper.json',
    content: {
      log: { loglevel: 'warning' },
      dns: { hosts: { 'www.cloudflare.com': '127.0.0.1' } },
      inbounds: [{
        tag: 'vless-in',
        listen: '127.0.0.1',
        port: 20801,
        protocol: 'vless',
        settings: { clients: [{ id: '11111111-2222-4333-8444-555555555555' }], decryption: 'none' }
      }],
      outbounds: [{ tag: 'direct', protocol: 'freedom' }]
    }
  },
  {
    name: 'g4-srvB-proper.json',
    content: {
      log: { loglevel: 'warning' },
      dns: { hosts: { 'www.cloudflare.com': '127.0.0.2' } },
      inbounds: [{
        tag: 'vless-in',
        listen: '127.0.0.1',
        port: 20802,
        protocol: 'vless',
        settings: { clients: [{ id: '99999999-8888-4777-8666-555555555555' }], decryption: 'none' }
      }],
      outbounds: [{ tag: 'direct', protocol: 'freedom' }]
    }
  }
];

for (const cfg of configs) {
  const cfgPath = path.join(evidence, cfg.name);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg.content, null, 2));
  console.log('wrote', cfg.name, 'len:', cfg.content.toString().length);
}

console.log('done');
