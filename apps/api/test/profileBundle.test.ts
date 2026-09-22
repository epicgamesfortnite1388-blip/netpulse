import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildProfileBundle, BundleError } from '../src/services/profileBundle';
import { FileSecretVault, SingboxProvider, VpnRegistry } from '../src/vpn/vpnService';

/**
 * The profile-bundle export for E2E encrypted cloud backup: the reconstructed
 * configText must be importable again (roundtrip), and every failure must be
 * the module's honest reason, not a stack trace.
 */
const dirs: string[] = [];

function makeRegistry(): { registry: VpnRegistry; provider: SingboxProvider; configDir: string } {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-bundle-'));
  dirs.push(configDir);
  const vaultFile = path.join(configDir, 'vault.key');
  const vault = new FileSecretVault(vaultFile);
  const provider = new SingboxProvider(vault, configDir, undefined, 20811, false);
  const registry = new VpnRegistry();
  registry['setVault'](vault);
  registry.register(provider);
  return { registry, provider, configDir };
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('profile bundle export', () => {
  it('reconstructs a sing-box outbound with the real credential from the vault', async () => {
    const { registry } = makeRegistry();
    const link = 'vless://11111111-2222-3333-4444-555555555555@example.com:443?security=tls&sni=example.com&type=ws#relay';
    const profile = await registry.get('singbox')!.importProfile({ name: 'relay', configText: link, protocol: 'custom' });
    registry.addProfile('singbox', profile);

    const bundle = buildProfileBundle(registry, profile.id);
    expect(bundle.providerId).toBe('singbox');
    expect(bundle.configText).toContain('11111111-2222-3333-4444-555555555555');
    expect(bundle.configText).not.toContain('<stored in vault>');

    // Roundtrip: importing the bundle yields the same endpoint + protocol.
    const again = await registry.get('singbox')!.importProfile({ name: 'restored', configText: bundle.configText, protocol: 'custom' });
    expect(again.protocol).toBe(profile.protocol);
    expect(again.endpoint).toBe(profile.endpoint);
  });

  it('refuses with the honest reason for unknown profiles', async () => {
    const { registry } = makeRegistry();
    expect(() => buildProfileBundle(registry, 'no-such-profile')).toThrow(BundleError);
    try {
      buildProfileBundle(registry, 'no-such-profile');
    } catch (err) {
      expect((err as BundleError).code).toBe('not_found');
    }
  });

  it('refuses profiles whose credential is missing or whose engine cannot export', () => {
    const { registry } = makeRegistry();
    // A profile-shaped row with a secretRef the vault never held.
    const ghost = { id: 'custom-x', name: 'x', protocol: 'custom', endpoint: null, publicKeyFingerprint: null, allowedIps: null, dns: null, secretRef: 'nope', configPath: '/none', createdAt: 1, providerId: 'aether' };
    registry.addProfile('aether', ghost as never);
    try {
      buildProfileBundle(registry, 'custom-x');
      throw new Error('must have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BundleError);
      expect((err as BundleError).code).toBe('credential_missing');
    }
  });
});
