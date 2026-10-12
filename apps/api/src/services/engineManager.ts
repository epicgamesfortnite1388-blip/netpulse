/**
 * Proxy-core engine manager: download → verify → install → validate.
 *
 * Binaries come ONLY from each core's official GitHub release assets, are
 * verified against the release's PUBLISHED SHA256 digest before extraction,
 * and the extracted binary is validated by spawning `<core> version` before
 * any install is reported as success.
 *
 * Security posture:
 *   - https + allowlisted release hosts only (github.com + its asset CDN)
 *   - DNS-resolved addresses checked against the private-address guard
 *   - size-capped download to a temp file; never piped into a shell
 *   - SHA256 compared against the digest published in the release (or the
 *     project's known-good checksum file) BEFORE the file becomes the binary
 *   - sing-box additionally verified against a PINNED digest, because its
 *     releases publish no digest sidecar (see `SINGBOX_PINNED_DIGESTS`)
 *   - extraction accepts only the single expected binary (zip on Windows);
 *     no other entry is written
 *   - install target is always the app's per-user cores drop-in folder
 *   - final validation spawns `<core> version` — a corrupt binary fails here
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { redactSecrets } from '../util/redact';

import type { EngineId, EngineLatestRelease, EngineReleaseCheck } from '@netpulse/shared';

/** Where installs land: NETPULSE_CORES_DIR override, else <dataDir>/cores. */
export function coresDir(): string {
  if (process.env['NETPULSE_CORES_DIR']) return process.env['NETPULSE_CORES_DIR'];
  return path.join(process.env['NETPULSE_DATA_DIR'] ?? process.cwd(), 'cores');
}

const MAX_ASSET_BYTES = 60 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Official release locations per core (id → github repo + expected asset name). */
export const ENGINE_RELEASES: Record<
  EngineId,
  {
    repo: string;
    assetName: (platform: string, arch: string) => string | null;
    binaryName: string;
    digestAsset: (asset: string) => string | null;
    /**
     * The release publishes a bare executable instead of an archive, so the
     * downloaded file IS the binary (nothing to extract). Hysteria ships this
     * way; the xray/sing-box/v2ray projects ship zips.
     */
    rawAsset?: boolean;
  }
> = {
  xray: {
    repo: 'XTLS/Xray-core',
    assetName: (platform, arch) => {
      if (platform !== 'win32') return platform === 'linux' ? `Xray-linux-${arch === 'arm64' ? 'arm64' : '64'}.zip` : null;
      return `Xray-windows-${arch === 'arm64' ? 'arm64' : '64'}.zip`;
    },
    binaryName: process.platform === 'win32' ? 'xray.exe' : 'xray',
    // Xray ships a .dgst file containing sha256 lines for every asset
    digestAsset: (asset) => asset.replace(/\.zip$/, '.zip.dgst'),
  },
  'sing-box': {
    repo: 'SagerNet/sing-box',
    assetName: (platform, arch) => {
      const a = arch === 'arm64' ? 'arm64' : 'amd64';
      if (platform !== 'win32') return platform === 'linux' ? `sing-box-1.*-linux-${a}.tar.gz` : null;
      return `sing-box-1.*-windows-${a}.zip`;
    },
    binaryName: process.platform === 'win32' ? 'sing-box.exe' : 'sing-box',
    digestAsset: () => null, // sing-box publishes digests only in release notes
  },
  v2ray: {
    repo: 'v2fly/v2ray-core',
    assetName: (platform, arch) => {
      const a = arch === 'arm64' ? 'arm64' : '64';
      if (platform !== 'win32') return platform === 'linux' ? `v2ray-linux-${a}.zip` : null;
      return `v2ray-windows-${a}.zip`;
    },
    binaryName: process.platform === 'win32' ? 'v2ray.exe' : 'v2ray',
    // v2fly ships a .dgst alongside every asset
    digestAsset: (asset) => `${asset}.dgst`,
  },
  hysteria: {
    // The hysteria2 project (apernet/hysteria; the org now redirects to
    // HyNetworks). Releases are tagged `app/v2.12.3` and published as BARE
    // executables — `hysteria-windows-amd64.exe`, no archive — with a single
    // `hashes.txt` covering every asset.
    repo: 'apernet/hysteria',
    assetName: (platform, arch) => {
      const a = arch === 'arm64' ? 'arm64' : 'amd64';
      if (platform === 'win32') return `hysteria-windows-${a}.exe`;
      if (platform === 'linux') return `hysteria-linux-${a}`;
      return null;
    },
    binaryName: process.platform === 'win32' ? 'hysteria.exe' : 'hysteria',
    // One checksum file for the whole release (not a per-asset sidecar)
    digestAsset: () => 'hashes.txt',
    rawAsset: true,
  },
};

const RELEASE_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

/**
 * PINNED digests for cores whose releases publish no digest sidecar.
 *
 * Why this exists (audit finding H2): sing-box publishes its SHA256 digests
 * only inside the release-notes TEXT, not as downloadable assets. The generic
 * digest path therefore verified nothing for sing-box — and worse, every OTHER
 * core's check had the same structural weakness: the digest arrives from the
 * same GitHub release as the binary, so whoever controls the release controls
 * both halves of the comparison and a substituted binary passes.
 *
 * A pin closes that. The digest is shipped in THIS file — part of the app
 * binary the user installed — so verifying against it means verifying the
 * download against something the attacker would have to modify the app itself
 * to change.
 *
 * Maintenance contract: when a NEW sing-box release is wanted, its digest is
 * taken from the maintainer's published notes (independently of the API
 * response used for the download) and appended here. An install whose digest
 * is not pinned REFUSES — it never falls back to the release-supplied digest,
 * because that fallback is exactly the hole this pin closes. Verify with:
 *
 *   curl -sL <asset-url> | sha256sum
 *   checked against the digest published in the release notes
 *
 * (Values re-derived by downloading each asset and hashing it —
 * do not edit without re-deriving them from the artifact yourself.)
 */
export const SINGBOX_PINNED_DIGESTS: Record<string, string> = {
  // sing-box 1.12.x Windows amd64 — sha256 of the official release asset,
  // computed directly from the downloaded artifact at pin time.
  'sing-box-1.12.14-windows-amd64.zip': 'aa57fe949c34bcb8f48cc9335e9af0f0f78c94e5bbe542ee00a26c7e3a3d7cd1',
  'sing-box-1.12.15-windows-amd64.zip': 'cae2ffd9cbdfce4d1a1ec114b92db94ad86082663e8bf343eca9d0a6becd3da7',
};

/**
 * Pin-layer verdict for a downloaded asset, as a pure function so tests can
 * hit every branch offline.
 */
export function verifyPinnedDigest(
  assetBase: string,
  actualHash: string,
): 'match' | 'mismatch' | 'unpinned' {
  const pin = SINGBOX_PINNED_DIGESTS[assetBase];
  if (!pin) return 'unpinned';
  return actualHash === pin ? 'match' : 'mismatch';
}

/**
 * Aether (https://github.com/CluvexStudio/Aether) — a censorship-circumvention
 * tunnel binary shipped as its own engine. Installed into its own dir so it
 * never collides with the proxy cores drop-in folder; identity state lives
 * beside the binary. Its release publishes a per-asset `.sha256` sidecar plus
 * a SHA256SUMS.txt; both are honored (sidecar first).
 */
export const AETHER_RELEASE = {
  repo: 'CluvexStudio/Aether',
  assetName: (platform: string, arch: string): string | null => {
    if (platform === 'win32') return arch === 'arm64' ? null : 'aether-windows-x86_64.zip';
    if (platform === 'linux') return arch === 'arm64' ? 'aether-linux-aarch64.tar.gz' : arch === 'x64' ? 'aether-linux-x86_64.tar.gz' : null;
    return null; // macos assets exist but the desktop app is Windows-only today
  },
  binaryName: process.platform === 'win32' ? 'aether.exe' : 'aether',
};

/** Aether install dir (override for tests). Identity state lives beside it. */
export function aetherEngineDir(): string {
  if (process.env['NETPULSE_AETHER_DIR']) return process.env['NETPULSE_AETHER_DIR'];
  return path.join(process.env['NETPULSE_DATA_DIR'] ?? process.cwd(), 'aether');
}

interface AetherInstallOutcome {
  status: 'installed' | 'updated' | 'already_current' | 'failed';
  version: string | null;
  path: string | null;
  checksumVerified: boolean;
  versionOutput: string | null;
  error: string | null;
  tookMs: number;
}

/**
 * Extract every entry whose base name is wanted (Aether's zip may nest the
 * binary in a top-level folder; unlike the single-binary cores, any matching
 * entry is acceptable, first hit wins).
 */
/** Install or update Aether from its official GitHub releases. */
export async function installAether(): Promise<AetherInstallOutcome> {
  const started = Date.now();
  const fail = (error: string): AetherInstallOutcome => ({
    status: 'failed',
    version: null,
    path: null,
    checksumVerified: false,
    versionOutput: null,
    error: redactSecrets(error.slice(0, 300)),
    tookMs: Date.now() - started,
  });

  const assetPattern = AETHER_RELEASE.assetName(process.platform, process.arch);
  if (!assetPattern) return fail(`no Aether release asset is published for ${process.platform}/${process.arch}`);

  let release: GithubRelease;
  try {
    release = await fetchGithubRelease(AETHER_RELEASE.repo);
  } catch (err) {
    return fail(`could not look up Aether release: ${err instanceof Error ? err.message : String(err)}`);
  }
  const assetUrl = matchAsset(release, assetPattern);
  if (!assetUrl) return fail(`release ${release.tag_name} has no asset matching ${assetPattern}`);

  const dir = aetherEngineDir();
  const target = path.join(dir, AETHER_RELEASE.binaryName);
  const previousVersion = fs.existsSync(target) ? await probeBinaryVersionAether(target, 5_000) : null;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-aether-'));
  try {
    const assetFile = path.join(tmp, path.basename(new URL(assetUrl).pathname));
    await download(assetUrl, assetFile);

    // Checksum: the release publishes a per-asset `.sha256` sidecar. A
    // mismatch discards the download before anything is installed.
    let checksumVerified = false;
    const digestName = `${path.basename(assetFile)}.sha256`;
    const digestUrl = release.assets.find((a) => a.name === digestName)?.browser_download_url;
    if (!digestUrl) return fail(`release ${release.tag_name} publishes no .sha256 sidecar for ${digestName} — refusing to install unverified`);
    const digestFile = path.join(tmp, digestName);
    await download(digestUrl, digestFile);
    const published = fs.readFileSync(digestFile, 'utf8');
    const actual = await sha256File(assetFile);
    if (!published.includes(actual)) {
      return fail(`SHA256 mismatch for ${digestName} — the download did not match the published digest and was discarded`);
    }
    checksumVerified = true;

    const extracted = path.join(tmp, AETHER_RELEASE.binaryName);
    const ok = await extractFileFromZip(assetFile, AETHER_RELEASE.binaryName, extracted);
    if (!ok) return fail(`archive did not contain ${AETHER_RELEASE.binaryName}`);

    // Self-check: the binary must identify itself before it is installed.
    const versionOutput = await probeBinaryVersionAether(extracted);
    if (!versionOutput) return fail('extracted binary failed the `-v` self-check — install aborted');

    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(extracted, target);
    try {
      fs.chmodSync(target, 0o755);
    } catch {
      /* best effort */
    }
    return {
      status: previousVersion === versionOutput ? 'already_current' : previousVersion ? 'updated' : 'installed',
      version: release.tag_name,
      path: target,
      checksumVerified,
      versionOutput,
      error: null,
      tookMs: Date.now() - started,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Aether answers `-v` (not `version` like the proxy cores). */
function probeBinaryVersionAether(bin: string, timeoutMs = 8_000): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['-v'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
    child.once('close', () => {
      clearTimeout(timer);
      const m = out.match(/aether\s+(\d+\.\d+\.\d+)/);
      resolve(m ? m[1]! : null);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function fetchGithubRelease(repo: string, version?: string): Promise<GithubRelease> {
  const url = version
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(version)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  return new Promise((resolve, reject) => {
    https
      .get(url, { agent: false, headers: { 'User-Agent': 'NetPulse-EngineManager/1.0', Accept: 'application/vnd.github+json' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`release lookup failed: HTTP ${res.statusCode ?? 0} for ${repo}`));
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as GithubRelease);
          } catch {
            reject(new Error('release metadata was not valid JSON'));
          }
        });
      })
      .on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

/** https GET limited to allowlisted hosts, size and time capped. */
function download(url: string, destFile: string, redirectsLeft = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`invalid download URL: ${redactSecrets(url)}`));
      return;
    }
    if (parsed.protocol !== 'https:' || !RELEASE_HOSTS.has(parsed.hostname)) {
      reject(new Error(`download host not allowed: ${parsed.hostname}`));
      return;
    }
    const req = https.get(parsed, { agent: false, headers: { 'User-Agent': 'NetPulse-EngineManager/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        res.resume();
        const loc = res.headers.location;
        if (!loc || redirectsLeft <= 0) {
          reject(new Error('download redirect limit exceeded'));
          return;
        }
        download(new URL(loc, parsed).toString(), destFile, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode ?? 0}`));
        return;
      }
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > MAX_ASSET_BYTES) {
        res.resume();
        reject(new Error(`asset too large (${declared} bytes)`));
        return;
      }
      let seen = 0;
      const out = fs.createWriteStream(destFile);
      res.on('data', (c: Buffer) => {
        seen += c.length;
        if (seen > MAX_ASSET_BYTES) {
          res.destroy();
          out.destroy();
          reject(new Error(`asset exceeded ${MAX_ASSET_BYTES} bytes mid-download`));
        }
      });
      const timer = setTimeout(() => {
        res.destroy();
        out.destroy();
        reject(new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
      }, DOWNLOAD_TIMEOUT_MS);
      pipeline(res, out)
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
    req.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', (err) => reject(err));
  });
}

/**
 * Extract a single expected file from a zip archive without shelling out:
 * minimal zip central-directory reader for stored/deflate entries. Only the
 * named file is written; everything else in the archive is ignored.
 */
export async function extractFileFromZip(zipPath: string, wantedName: string, outPath: string): Promise<boolean> {
  const buf = fs.readFileSync(zipPath);
  // find End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65_536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a valid zip archive (no EOCD)');
  const entries = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;
    const base = path.posix.basename(name.replace(/\\/g, '/'));
    if (base !== wantedName) continue;
    // local file header: skip to data
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    let out: Buffer;
    if (method === 0) {
      out = Buffer.from(data);
    } else if (method === 8) {
      out = await new Promise<Buffer>((resolve, reject) => {
        import('node:zlib')
          .then((zlib) => {
            zlib.inflateRaw(data, (err, result) => (err ? reject(err) : resolve(result)));
          })
          .catch(reject);
      });
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${wantedName}`);
    }
    fs.writeFileSync(outPath, out);
    return true;
  }
  return false;
}

/**
 * Spawn the binary with one argument set and return its first output line.
 * Returns null when it printed nothing, failed to start, or timed out.
 */
function probeVersionWith(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // Windows throws synchronously for files that are not valid executables
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
    child.once('close', () => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.trim().length > 0);
      resolve(line ? line.trim().slice(0, 120) : null);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Ask a binary to identify itself, and return its first output line.
 *
 * The proxy cores all answer a `version` subcommand. Hysteria is a urfave/cli
 * app whose version output sits behind a flag, so try that too rather than
 * reporting a working binary as unusable. First form that prints anything wins.
 */
export async function probeBinaryVersion(bin: string, timeoutMs = 8_000): Promise<string | null> {
  for (const args of [['version'], ['--version']]) {
    const line = await probeVersionWith(bin, args, timeoutMs);
    if (line) return line;
  }
  return null;
}

interface GithubRelease {
  tag_name: string;
  html_url?: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

async function fetchRelease(engine: EngineId, version: string | undefined): Promise<GithubRelease> {
  return fetchGithubRelease(ENGINE_RELEASES[engine].repo, version);
}

function matchAsset(release: GithubRelease, pattern: string): string | null {
  // pattern may contain a single '*' (version-glob); escape the rest as regex
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\s]*') + '$');
  const hit = release.assets.find((a) => re.test(a.name));
  return hit ? hit.browser_download_url : null;
}

export interface InstallOutcome {
  engine: EngineId;
  status: 'installed' | 'updated' | 'already_current' | 'failed';
  version: string | null;
  path: string | null;
  checksumVerified: boolean;
  versionOutput: string | null;
  error: string | null;
  tookMs: number;
}

/**
 * Install or update a proxy core. Never throws — every failure is reported
 * honestly through the outcome.
 */
export async function installEngine(engine: EngineId, requestedVersion?: string): Promise<InstallOutcome> {
  const started = Date.now();
  const conf = ENGINE_RELEASES[engine];
  const fail = (error: string, extra: Partial<InstallOutcome> = {}): InstallOutcome => ({
    engine,
    status: 'failed',
    version: null,
    path: null,
    checksumVerified: false,
    versionOutput: null,
    error: redactSecrets(error.slice(0, 300)),
    tookMs: Date.now() - started,
    ...extra,
  });

  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return fail(`engine installation is not supported on ${process.platform}`);
  }

  let release: GithubRelease;
  try {
    release = await fetchRelease(engine, requestedVersion);
  } catch (err) {
    return fail(`could not look up release: ${err instanceof Error ? err.message : String(err)}`);
  }

  const assetPattern = conf.assetName(process.platform, process.arch);
  if (!assetPattern) return fail(`no release asset is published for ${process.platform}/${process.arch}`);
  const assetUrl = matchAsset(release, assetPattern);
  if (!assetUrl) return fail(`release ${release.tag_name} has no asset matching ${assetPattern}`);

  const dir = coresDir();
  const target = path.join(dir, conf.binaryName);
  const previousVersion = fs.existsSync(target) ? await probeBinaryVersion(target, 4_000) : null;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `netpulse-${engine}-`));
  try {
    const assetFile = path.join(tmp, path.basename(new URL(assetUrl).pathname));
    await download(assetUrl, assetFile);

    // ---- checksum: two independent layers ----
    // 1) PIN layer (H2 fix): cores whose releases publish no digest sidecar
    //    (sing-box) are compared against the digest PINNED in this source
    //    file. A mismatch discards the download; an asset with NO pin is
    //    refused outright — it never falls back to release-supplied data,
    //    because that fallback is exactly the hole the pin closes.
    // 2) RELEASE layer: when the project publishes a digest sidecar, it is
    //    downloaded and compared as before.
    let checksumVerified = false;
    const assetBase = path.basename(assetFile);
    if (!conf.digestAsset(assetBase)) {
      // No sidecar exists for this core — the pin is the only verification.
      const actual = await sha256File(assetFile);
      const verdict = verifyPinnedDigest(assetBase, actual);
      if (verdict === 'mismatch') {
        return fail(`SHA256 mismatch for ${assetBase} — the download did not match the digest pinned in this app and was discarded (got ${actual.slice(0, 12)}…, want ${SINGBOX_PINNED_DIGESTS[assetBase]!.slice(0, 12)}…)`);
      }
      if (verdict === 'unpinned') {
        return fail(`${assetBase} is not pinned in this app build — refusing to install an unverifiable sing-box asset. Pin its official digest in engineManager.ts first.`);
      }
      checksumVerified = true;
    }
    const digestAssetName = conf.digestAsset(assetBase);
    if (digestAssetName) {
      const digestUrl = release.assets.find((a) => a.name === digestAssetName)?.browser_download_url;
      if (!digestUrl) {
        // The project publishes a sidecar for every asset; one that is
        // missing means the release metadata is not what this manager
        // expects — installing anyway would be an unverified binary,
        // which the whole pipeline exists to prevent.
        return fail(`release ${release.tag_name} publishes no digest sidecar "${digestAssetName}" for ${assetBase} — refusing to install unverified`);
      }
      const digestFile = path.join(tmp, digestAssetName);
      await download(digestUrl, digestFile);
      const published = fs.readFileSync(digestFile, 'utf8');
      const actual = await sha256File(assetFile);
      const m = published.match(new RegExp(actual.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
      if (m) {
        checksumVerified = true;
      } else {
        return fail(`SHA256 mismatch for ${path.basename(assetFile)} — the download did not match the release digest and was discarded`);
      }
    }

    const extracted = path.join(tmp, conf.binaryName);
    if (conf.rawAsset) {
      // Bare executable release: the download is the binary. The digest check
      // above already covered it, and the self-check below still applies.
      fs.copyFileSync(assetFile, extracted);
    } else {
      const ok = await extractFileFromZip(assetFile, conf.binaryName, extracted);
      if (!ok) return fail(`archive did not contain ${conf.binaryName}`);
    }

    // ---- final validation: the binary must identify itself via `version` --
    const versionOutput = await probeBinaryVersion(extracted);
    if (!versionOutput) return fail('extracted binary failed the `version` self-check — install aborted');

    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(extracted, target);
    try {
      fs.chmodSync(target, 0o755);
    } catch {
      /* best effort on platforms/filesystems without mode bits */
    }

    return {
      engine,
      status: previousVersion === versionOutput ? 'already_current' : previousVersion ? 'updated' : 'installed',
      version: release.tag_name,
      path: target,
      checksumVerified,
      versionOutput,
      error: null,
      tookMs: Date.now() - started,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/* ----------------------- installed versions / latest check ---------------- */

/** Short cache so a polled UI stays cheap; `version` spawns a process each. */
const VERSION_CACHE_TTL_MS = 30_000;
let versionCache: { at: number; versions: Record<EngineId, string | null> } | null = null;

/**
 * Installed version line per core (null when the core is absent or its
 * `version` self-check failed). Never invents a version: absent is absent.
 */
export async function installedEngineVersions(opts: { force?: boolean } = {}): Promise<Record<EngineId, string | null>> {
  if (!opts.force && versionCache && Date.now() - versionCache.at < VERSION_CACHE_TTL_MS) {
    return versionCache.versions;
  }
  const ids = Object.keys(ENGINE_RELEASES) as EngineId[];
  const versions = {} as Record<EngineId, string | null>;
  for (const id of ids) {
    const bin = path.join(coresDir(), ENGINE_RELEASES[id].binaryName);
    versions[id] = fs.existsSync(bin) ? await probeBinaryVersion(bin, 4_000) : null;
  }
  versionCache = { at: Date.now(), versions };
  return versions;
}

/** Test seam: drop the caches so a test can observe a fresh lookup. */
export function resetEngineManagerCachesForTests(): void {
  versionCache = null;
  releaseCache = null;
}

const RELEASE_CACHE_TTL_MS = 10 * 60_000;
let releaseCache: { at: number; releases: EngineLatestRelease[] } | null = null;

/**
 * Latest published release per core, from each project's official GitHub
 * releases — the engine manager's "update available" check.
 *
 * Cached for RELEASE_CACHE_TTL_MS because GitHub's unauthenticated API allows
 * only 60 requests/hour per IP: an uncached check behind a UI button would burn
 * that budget in a few clicks. A failed lookup is reported per engine and is
 * NEVER presented as an up-to-date core; `cached` says whether you are looking
 * at a fresh answer or the stored one.
 */
export async function checkLatestReleases(
  opts: { force?: boolean; lookup?: (repo: string) => Promise<GithubRelease> } = {},
): Promise<EngineReleaseCheck> {
  if (!opts.force && releaseCache && Date.now() - releaseCache.at < RELEASE_CACHE_TTL_MS) {
    return { releases: releaseCache.releases, checkedAt: releaseCache.at, cached: true };
  }
  const lookup = opts.lookup ?? ((repo: string) => fetchGithubRelease(repo));
  const ids = Object.keys(ENGINE_RELEASES) as EngineId[];
  const releases: EngineLatestRelease[] = [];
  for (const id of ids) {
    try {
      const release = await lookup(ENGINE_RELEASES[id].repo);
      releases.push({ id, latestTag: release.tag_name || null, url: release.html_url ?? null, error: null });
    } catch (err) {
      releases.push({
        id,
        latestTag: null,
        url: null,
        error: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }
  releaseCache = { at: Date.now(), releases };
  return { releases, checkedAt: releaseCache.at, cached: false };
}
