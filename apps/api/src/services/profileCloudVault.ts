import { FileSecretVault } from '../vpn/vpnService';

/**
 * At-rest sealer for profile configs headed for the cloud.
 *
 * Why this lives on the server: cloud profile backup used to be built in the
 * webview. The API handed the browser a profile's real `configText` (the
 * `/vpn/profiles/:id/bundle` route), the browser encrypted it with the
 * password-derived E2E key and uploaded the blob. That made restore impossible
 * to do without ever showing a config to the user — the blob can only be opened
 * by the machine holding the E2E key, which is the browser, so restore had to
 * decrypt into the page and then hand plaintext back to the API to re-import.
 *
 * Moving the backup here means the config never leaves this process: it is read
 * from the file vault, sealed, and pushed; on restore it is pulled, opened, and
 * written straight into the engine's own profile store. The browser sees a
 * profile id and a name.
 *
 * ## Key management — read this before trusting the cloud copy
 *
 * The seal key is a `FileSecretVault` key, historically a random 32 bytes
 * written next to the ciphertext it protects:
 *
 *     <dataDir>/secrets/vault.cloud.key
 *
 * That was a real weakness worth naming plainly: **the key sat beside what it
 * encrypts.** Anyone who could read the data directory — a backup sync, a stolen
 * disk, a support bundle — could decrypt every backed-up config. It bought
 * protection against the cloud operator and against a stolen cloud database,
 * not against local filesystem access.
 *
 * **Closed on Windows** (see `vpn/keychain.ts`): the key now lives in Windows
 * Credential Manager under the current user, protected by DPAPI, so the data
 * directory holds only ciphertext. An existing `.key` file is adopted and
 * removed on first use, verified by a round-trip read first.
 *
 * Still true, and worth stating: this protects local filesystem access, not the
 * cloud half — the blob is sealed with the local key before it leaves the
 * machine, so the cloud operator cannot read it either way. On non-Windows
 * platforms the key file fallback still applies and this paragraph still
 * describes it accurately.
 */
export class ProfileCloudVault {
  private readonly vault: FileSecretVault;

  constructor(file: string) {
    this.vault = new FileSecretVault(`${file}.cloud`);
  }

  /**
   * Seal one profile's backup payload. `envelopeId` is the cloud-side profile id
   * (`np-local-<profileId>`), so a blob is only ever opened under the name it
   * was stored under.
   */
  seal(envelopeId: string, payload: unknown): string {
    return this.vault.seal(envelopeId, JSON.stringify(payload)).toString('base64');
  }

  /**
   * Open a blob back into its payload, or `null` when it cannot be read.
   *
   * A null here is a legitimate answer, not only corruption: blobs written by
   * the old webview path were sealed with the account's password-derived E2E
   * key, which this process has never had. Those are reported as
   * `legacy_blob_unreadable` by the caller so the user is told the real reason
   * instead of watching a decrypt failure.
   */
  open<T>(envelopeId: string, ciphertext: string): T | null {
    try {
      return JSON.parse(this.vault.open(envelopeId, Buffer.from(ciphertext, 'base64'))) as T;
    } catch {
      return null;
    }
  }

  /** The ref a given envelope is stored under, for diagnostics. */
  static refFor(envelopeId: string): string {
    return envelopeId;
  }
}

/** What the cloud stores for one profile. Only the fields restore needs. */
export interface CloudProfilePayload {
  providerId: string;
  name: string;
  configText: string;
}