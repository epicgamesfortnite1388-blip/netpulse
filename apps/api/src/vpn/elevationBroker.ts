import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { badRequest } from '../util/appError';
import { WIREGUARD_EXES } from '../util/privileges';

import type { RealtimeBus } from '../realtime/bus';
import type { Logger } from '../logger';

export type ElevationAction = 'wireguard-install-tunnel';

/**
 * Allowed WireGuard executables — the SAME list `util/privileges` uses to report
 * whether the WireGuard capability is available, so "available" and "may be
 * launched" can never disagree. (Rust keeps its own independent copy: that is
 * the point of a second validator, not duplication to remove.)
 */
const ALLOWED_WIREGUARD_EXES = WIREGUARD_EXES;

export const ELEVATION_TOPIC = 'vpn-elevation';

/**
 * Descriptor the sidecar hands to the Rust elevation broker for ONE pending
 * privileged operation. Everything here is re-validated by Rust before the
 * UAC prompt appears — this file is the sidecar's honest offer, not a trust
 * boundary in itself.
 */
export interface ElevationOpDescriptor {
  action: ElevationAction;
  /** Absolute path to the allow-listed executable to elevate. */
  exe: string;
  /** Exact argument vector (validated to a fixed shape by both sides). */
  args: string[];
  /** Random nonce minted for THIS op; echoed by Rust on pending + result. */
  nonce: string;
  /** SHA-256 of the staged config at materialization time (TOCTOU guard). */
  configSha256: string;
}

type ResolveFn = (outcome: ElevationOutcome) => void;

export interface ElevationOutcome {
  ok: boolean;
  /** True when the user actively declined the UAC prompt. */
  declined: boolean;
  error: string | null;
  /** Who resolved the op: the Rust bridge, or expiry/validation here. */
  source: 'bridge' | 'expired' | 'invalid' | 'unknown-op';
}

interface PendingOp {
  opId: string;
  nonce: string;
  descriptor: ElevationOpDescriptor;
  createdAt: number;
  expiresAt: number;
  resolve: ResolveFn;
}

export const ELEVATION_TTL_MS = 120_000; // UAC prompts can sit; 2 min is generous

/**
 * Broker for per-action elevation of WireGuard tunnel installation.
 *
 * Contract with the Rust bridge (`src-tauri/src/elevation.rs`):
 *  - `GET /vpn/elevation/pending?opId=…` (Bearer token) → the descriptor,
 *    IF the `nonce` query param matches the op's nonce (the UI forwards it;
 *    the Rust command received it from the UI's IPC). Wrong/missing nonce or
 *    an unknown/expired opId is a 404. The webview's own origin is excluded:
 *    only the broker loopback caller presents the header, but the nonce check
 *    additionally binds the call to the UI round-trip.
 *  - `POST /vpn/elevation/result?opId=…&nonce=…` (Bearer token) → resolves
 *    the pending connect promise with the launch outcome.
 *
 * Security properties:
 *  - descriptors only ever reference the allow-listed wireguard.exe and a
 *    fixed argument shape (re-validated in Rust);
 *  - ops expire (TTL) and are single-use;
 *  - the webview never receives the nonce→descriptor mapping beyond its own
 *    opId, and cannot fetch a descriptor (it lacks the Bearer token);
 *  - nothing here logs key material or the config contents.
 */
export class ElevationBroker {
  private readonly pending = new Map<string, PendingOp>();

  constructor(
    private readonly deps: {
      appDataDir: string;
      bus: RealtimeBus;
      log: Logger;
    },
  ) {}

  /**
   * Register a pending WireGuard tunnel-install operation. The descriptor is
   * built HERE from the materialized config path — callers pass no exe/args,
   * only what the sidecar itself staged.
   */
  registerWireGuardInstall(input: { opId: string; configPath: string }): { opId: string; nonce: string; expiresAt: number } {
    if (process.platform !== 'win32') {
      throw badRequest('elevation_unsupported', 'Per-action elevation is only implemented on Windows');
    }
    const exe = ALLOWED_WIREGUARD_EXES.find((p) => fs.existsSync(p));
    if (!exe) {
      throw badRequest('wireguard_missing', 'WireGuard is not installed in Program Files — cannot prepare an elevated tunnel install');
    }
    if (!path.isAbsolute(input.configPath) || path.extname(input.configPath) !== '.conf') {
      throw badRequest('invalid_config_path', 'Tunnel config path must be an absolute .conf path inside the app data dir');
    }
    // The staged config must live under OUR data dir — Rust enforces this
    // independently; checking here gives a fast, honest failure.
    const dataDir = path.resolve(this.deps.appDataDir);
    const resolved = path.resolve(input.configPath);
    if (!resolved.startsWith(dataDir + path.sep)) {
      throw badRequest('invalid_config_path', 'Tunnel config is outside the app data directory');
    }
    let configSha256: string;
    try {
      configSha256 = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
    } catch {
      throw badRequest('invalid_config_path', 'Tunnel config could not be read for integrity hashing');
    }

    // Sweep first so a burst of ops cannot accumulate.
    this.sweep();
    const nonce = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + ELEVATION_TTL_MS;
    const opId = input.opId;
    this.pending.set(opId, {
      opId,
      nonce,
      descriptor: {
        action: 'wireguard-install-tunnel',
        exe,
        args: ['/installtunnelservice', resolved],
        nonce,
        configSha256,
      },
      createdAt: Date.now(),
      expiresAt,
      resolve: () => undefined, // replaced by wait() when the connect flow awaits
    });
    this.deps.log.info({ opId, ttlMs: ELEVATION_TTL_MS }, 'elevation op registered');
    this.deps.bus.publish(ELEVATION_TOPIC, { type: 'elevation:pending', opId });
    return { opId, nonce, expiresAt };
  }

  /** Fetch a descriptor for the Rust bridge. Re-hashes the staged config at
   * fetch time so the hash Rust verifies is the hash of the file it will
   * launch (closes the staging→launch TOCTOU window to staging→fetch). */
  fetchForBridge(opId: string, nonce: string | null): ElevationOpDescriptor {
    const op = this.pending.get(opId);
    if (!op) throw badRequest('unknown_elevation_op', 'No pending elevation operation for this id');
    if (op.expiresAt <= Date.now()) {
      this.failOp(opId, 'expired', 'Elevation request expired — retry the connect');
      throw badRequest('unknown_elevation_op', 'This elevation request has expired');
    }
    // Nonce binding: the bridge must present the nonce that traveled UI →
    // Rust. A caller that knows only the opId (or only the token) cannot
    // pull descriptors.
    if (!nonce || nonce.length < 16 || nonce !== op.nonce) {
      throw badRequest('nonce_mismatch', 'Elevation nonce does not match this operation');
    }
    this.refreshDescriptorHash(opId, nonce);
    return op.descriptor;
  }

  /** Re-hash the staged config for a pending op (TOCTOU guard). */
  refreshDescriptorHash(opId: string, nonce: string | null): void {
    const op = this.pending.get(opId);
    if (!op || !nonce || nonce !== op.nonce) return;
    try {
      const configPath = op.descriptor.args[1];
      if (configPath == null) return;
      op.descriptor.configSha256 = crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
    } catch {
      // The file may legitimately be gone (connect failed before
      // materializing). Rust will reject a missing/unhashable file anyway.
    }
  }

  /** Resolve a pending op with the bridge's launch outcome. */
  resolveFromBridge(opId: string, nonce: string | null, outcome: { ok: boolean; error: string | null }): boolean {
    const op = this.pending.get(opId);
    if (!op) return false;
    if (!nonce || nonce !== op.nonce) {
      this.deps.log.warn({ opId }, 'elevation result rejected: nonce mismatch');
      return false;
    }
    this.pending.delete(opId);
    const full: ElevationOutcome = {
      ok: outcome.ok,
      declined: outcome.error != null && outcome.error.startsWith('ELEVATION_DECLINED'),
      error: outcome.error,
      source: 'bridge',
    };
    op.resolve(full);
    this.deps.bus.publish(ELEVATION_TOPIC, { type: 'elevation:resolved', opId, ok: outcome.ok });
    return true;
  }

  /**
   * Await the outcome of a registered op. Resolves when the bridge reports,
   * or with an honest failure when the TTL lapses.
   */
  wait(opId: string, timeoutMs = ELEVATION_TTL_MS + 10_000): Promise<ElevationOutcome> {
    const op = this.pending.get(opId);
    if (!op) {
      return Promise.resolve({ ok: false, declined: false, error: 'unknown elevation op', source: 'unknown-op' as const });
    }
    return new Promise<ElevationOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(opId)) {
          this.pending.delete(opId);
          resolve({ ok: false, declined: false, error: 'elevation prompt timed out', source: 'expired' as const });
        }
      }, timeoutMs);
      timer.unref?.();
      op.resolve = (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      };
    });
  }

  /** Number of live pending ops (tests/health). */
  size(): number {
    this.sweep();
    return this.pending.size;
  }

  private failOp(opId: string, source: ElevationOutcome['source'], error: string): void {
    const op = this.pending.get(opId);
    if (!op) return;
    this.pending.delete(opId);
    op.resolve({ ok: false, declined: false, error, source });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, op] of this.pending) {
      if (op.expiresAt <= now) {
        this.pending.delete(id);
        op.resolve({ ok: false, declined: false, error: 'elevation request expired', source: 'expired' as const });
      }
    }
  }
}
