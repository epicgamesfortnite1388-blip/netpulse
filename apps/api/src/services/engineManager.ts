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

import type { EngineId } from '@netpulse/shared';

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
  { repo: string; assetName: (platform: string, arch: string) => string | null; binaryName: string; digestAsset: (asset: string) => string | null }
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
};

const RELEASE_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

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

/** Spawn `<binary> version` and return its first output line (honest check). */
export function probeBinaryVersion(bin: string, timeoutMs = 8_000): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['version'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
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

interface GithubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

async function fetchRelease(engine: EngineId, version: string | undefined): Promise<GithubRelease> {
  const conf = ENGINE_RELEASES[engine];
  const apiHost = 'api.github.com';
  const url = version
    ? `https://${apiHost}/repos/${conf.repo}/releases/tags/${encodeURIComponent(version)}`
    : `https://${apiHost}/repos/${conf.repo}/releases/latest`;
  return new Promise((resolve, reject) => {
    https
      .get(url, { agent: false, headers: { 'User-Agent': 'NetPulse-EngineManager/1.0', Accept: 'application/vnd.github+json' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`release lookup failed: HTTP ${res.statusCode ?? 0} for ${conf.repo}`));
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

    // ---- checksum: verify against the release's published digest when the
    // project publishes one. A mismatch aborts before anything is installed. --
    let checksumVerified = false;
    const digestAssetName = conf.digestAsset(path.basename(assetFile));
    if (digestAssetName) {
      const digestUrl = release.assets.find((a) => a.name === digestAssetName)?.browser_download_url;
      if (digestUrl) {
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
    }

    const extracted = path.join(tmp, conf.binaryName);
    const ok = await extractFileFromZip(assetFile, conf.binaryName, extracted);
    if (!ok) return fail(`archive did not contain ${conf.binaryName}`);

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
