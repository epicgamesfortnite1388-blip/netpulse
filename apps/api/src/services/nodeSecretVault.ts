import { FileSecretVault } from '../vpn/vpnService';

/**
 * At-rest vault for public-node connection secrets (uuid / password).
 *
 * Why this exists: imports parsed the secret, used it for dedup hashing, then
 * threw it away — proxy tests ran with `secret: null` and could never succeed
 * for vless/vmess/trojan/ss. Secrets now persist encrypted (AES-256-GCM, same
 * FileSecretVault used for VPN profiles) keyed by node id; they never enter
 * the database, the API surface, or logs.
 */
export class NodeSecretVault {
  private readonly vault: FileSecretVault;

  constructor(file: string) {
    this.vault = new FileSecretVault(`${file}.nodes`);
  }

  set(nodeId: string, secret: string): void {
    this.vault.set(`node:${nodeId}`, secret);
  }

  get(nodeId: string): string | null {
    return this.vault.get(`node:${nodeId}`);
  }

  delete(nodeId: string): void {
    this.vault.delete(`node:${nodeId}`);
  }
}
