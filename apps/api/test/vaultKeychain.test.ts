import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FileKeyStore,
  WindowsCredentialKeyStore,
  credentialTargetFor,
  type KeyRead,
  type VaultKeyStore,
} from '../src/vpn/keychain';
import { FileSecretVault } from '../src/vpn/vpnService';

/**
 * The vault key moving into Windows Credential Manager.
 *
 * The properties tested here are the ones whose failure is silent and
 * catastrophic: a rekey that leaves every existing secret unreadable, or a
 * "no key yet" answer mistaken for "the store is broken". Nothing in the
 * product would throw — the vault simply starts returning null for secrets
 * that are still on disk.
 */

/** Store that is genuinely unusable — reads and writes both fail. */
class UnavailableStore implements VaultKeyStore {
  readonly id = 'test-unavailable';
  read(): KeyRead {
    return { state: 'error', error: 'credential store unavailable' };
  }
  write(): { ok: boolean; error?: string } {
    return { ok: false, error: 'credential store unavailable' };
  }
  delete(): void {
    /* nothing to delete */
  }
}

/** Store that accepts a write but never returns it — a write that did not stick. */
class WriteOnlyStore implements VaultKeyStore {
  readonly id = 'test-writeonly';
  read(): KeyRead {
    return { state: 'missing' };
  }
  write(): { ok: boolean; error?: string } {
    return { ok: true };
  }
  delete(): void {
    /* nothing to delete */
  }
}

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-vault-keychain-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('credential target naming', () => {
  it('gives every data directory its own target', () => {
    // Two vaults in different directories share basenames like `vault.nodes`
    // everywhere in this app. If they collided, one vault would adopt another
    // vault's key and silently fail to decrypt its own ciphertext.
    const a = credentialTargetFor('/one/data/secrets/vault.nodes');
    const b = credentialTargetFor('/two/data/secrets/vault.nodes');
    expect(a).not.toBe(b);
  });

  it('is stable for the same file', () => {
    const p = path.join(dir, 'stable-vault');
    expect(credentialTargetFor(p)).toBe(credentialTargetFor(p));
  });

  it('keeps the name free of characters Windows rejects', () => {
    const target = credentialTargetFor(path.join(dir, 'we ird:vault'));
    expect(target).toMatch(/^NetPulse\/vault\/[A-Za-z0-9._-]+$/);
  });
});

describe('a failing key store never rekeys the vault', () => {
  it('reads existing secrets back through the file fallback', () => {
    const file = path.join(dir, 'fallback', 'vault');
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // The store is broken from the start, so this vault can only fall back to
    // the key file — which is the pre-keychain behaviour, byte for byte.
    const v1 = new FileSecretVault(file, new UnavailableStore());
    v1.set('node:1', 'uuid-of-node-one');
    expect(fs.existsSync(`${file}.key`)).toBe(true);

    // A second instance must resolve to the SAME key. If the broken store had
    // caused a fresh key to be minted, this get() would return null and every
    // secret already on disk would be lost with nothing to tell the user why.
    const v2 = new FileSecretVault(file, new UnavailableStore());
    expect(v2.get('node:1')).toBe('uuid-of-node-one');
  });

  it('falls back when a store write does not round-trip', () => {
    const file = path.join(dir, 'roundtrip', 'vault');
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const v = new FileSecretVault(file, new WriteOnlyStore());
    v.set('profile:a', 'wg-private-key');
    expect(fs.existsSync(`${file}.key`)).toBe(true);

    // The store still reports "missing", so the vault must be reading from the
    // file rather than returning nothing.
    expect(v.get('profile:a')).toBe('wg-private-key');
  });
});

describe('seal/open are unchanged by where the key lives', () => {
  it('produces a blob that opens with the same vault', () => {
    const file = path.join(dir, 'seal', 'vault.cloud');
    const v = new FileSecretVault(file, new UnavailableStore());
    const blob = v.seal('np-local-1', JSON.stringify({ plan: 'pro' }));
    expect(blob).toBeInstanceOf(Buffer);
    expect(v.open('np-local-1', blob)).toBe(JSON.stringify({ plan: 'pro' }));
  });

  it('still refuses a blob sealed under another key', () => {
    const a = new FileSecretVault(path.join(dir, 'sealA', 'vault'), new UnavailableStore());
    const b = new FileSecretVault(path.join(dir, 'sealB', 'vault'), new UnavailableStore());
    const blob = a.seal('ref', 'payload');
    expect(() => b.open('ref', blob)).toThrow();
  });
});

// The real store: skipped off Windows, where Credential Manager does not exist.
describe.runIf(process.platform === 'win32')('Windows Credential Manager store', () => {
  it('round-trips a key through the real credential store', () => {
    const target = credentialTargetFor(path.join(dir, 'roundtrip-real'));
    const store = new WindowsCredentialKeyStore(target);
    store.delete();

    expect(store.read().state).toBe('missing');

    const key = Buffer.alloc(32, 7);
    expect(store.write(key).ok).toBe(true);

    const back = store.read();
    expect(back.state).toBe('ok');
    expect(back.state === 'ok' && back.value.equals(key)).toBe(true);

    store.delete();
    expect(store.read().state).toBe('missing');
  });

  it('migrates an existing key file into the store and removes the file', () => {
    const file = path.join(dir, 'migrate', 'vault');
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const store = new WindowsCredentialKeyStore(credentialTargetFor(file));
    store.delete(); // start from a clean store so this test is not order-dependent

    // Phase 1: the pre-keychain world — the key sits beside the ciphertext.
    const legacy = new FileSecretVault(file, new FileKeyStore(`${file}.key`));
    legacy.set('node:42', 'secret-that-must-survive');
    expect(fs.existsSync(`${file}.key`)).toBe(true);

    // Phase 2: the same vault, now backed by Credential Manager.
    const migrated = new FileSecretVault(file, store);

    // The existing secret still opens — the key was adopted, not replaced.
    expect(migrated.get('node:42')).toBe('secret-that-must-survive');
    // …and the key file is gone, which is the whole point of the change.
    expect(fs.existsSync(`${file}.key`)).toBe(false);

    // Writes land in the store, not in a new file.
    migrated.set('node:7', 'second-secret');
    expect(fs.existsSync(`${file}.key`)).toBe(false);
    expect(migrated.get('node:7')).toBe('second-secret');

    // A fresh instance reads from the store alone.
    const again = new FileSecretVault(file, store);
    expect(again.get('node:42')).toBe('secret-that-must-survive');
    expect(again.get('node:7')).toBe('second-secret');

    store.delete();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
