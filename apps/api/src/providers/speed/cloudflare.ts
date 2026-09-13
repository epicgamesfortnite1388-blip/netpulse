import type { IpFamily, SpeedTestRequest, ThroughputSample } from '@netpulse/shared';

export interface ThroughputRun {
  samples: ThroughputSample[];
  /** sustained throughput across the whole window, Mbps */
  mbps: number | null;
  bytes: number;
  durationMs: number;
  error?: string;
}

export interface SpeedRunOptions {
  durationMs: number;
  streams: number;
  onSample?: (sample: ThroughputSample, pct: number) => void;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

export interface SpeedTestProvider {
  readonly name: string;
  readonly serverLabel: string;
  download(opts: SpeedRunOptions): Promise<ThroughputRun>;
  upload(opts: SpeedRunOptions): Promise<ThroughputRun>;
  /** reference latency target for ping/jitter (resolved IP or host) */
  pingTarget(family?: IpFamily): string;
}

const DOWNLOAD_URL = 'https://speed.cloudflare.com/__down?bytes=';
const UPLOAD_URL = 'https://speed.cloudflare.com/__up';
const CHUNK_BYTES = 25_000_000; // 25 MB per request; long downloads recycle
const UPLOAD_CHUNK_BYTES = 2_000_000; // 2 MB per POST — real request granularity

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Cloudflare speed test (speed.cloudflare.com __down / __up).
 * Real streaming measurement: throughput is derived from actual bytes
 * received/sent over the measurement window — never simulated.
 */
export class CloudflareSpeedProvider implements SpeedTestProvider {
  readonly name = 'cloudflare';
  readonly serverLabel = 'speed.cloudflare.com';

  pingTarget(_family?: IpFamily): string {
    return '1.1.1.1';
  }

  async download(opts: SpeedRunOptions): Promise<ThroughputRun> {
    const startedAt = nowMs();
    // epoch-based deadline: the loop conditions below compare against Date.now()
    const deadline = Date.now() + opts.durationMs;
    const samples: ThroughputSample[] = [];
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let totalBytes = 0;
    let error: string | undefined;

    const streamWorker = async (): Promise<void> => {
      while (Date.now() < deadline && !controller.signal.aborted) {
        try {
          const res = await fetch(`${DOWNLOAD_URL}${CHUNK_BYTES}`, {
            signal: controller.signal,
            headers: { accept: '*/*' },
          });
          if (!res.ok || !res.body) {
            error = `download endpoint returned HTTP ${res.status}`;
            return;
          }
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value?.byteLength ?? 0;
            if (Date.now() >= deadline) {
              controller.abort();
              break;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) break;
          error = err instanceof Error ? err.message : String(err);
          return;
        }
      }
    };

    // sample collector
    const sampler = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const elapsed = nowMs() - startedAt;
        if (elapsed <= 0) return;
        const mbps = (totalBytes * 8) / (elapsed / 1000) / 1e6;
        const sample: ThroughputSample = { t: Date.now(), bytes: totalBytes, mbps: Math.round(mbps * 100) / 100 };
        samples.push(sample);
        opts.onSample?.(sample, Math.min(100, Math.round((elapsed / opts.durationMs) * 100)));
        if (Date.now() >= deadline || controller.signal.aborted) {
          clearInterval(interval);
          resolve();
        }
      }, 250);
    });

    await Promise.all(Array.from({ length: opts.streams }, () => streamWorker()));
    await sampler;
    opts.signal?.removeEventListener('abort', onExternalAbort);

    const durationMs = nowMs() - startedAt;
    const mbps = totalBytes > 0 && durationMs > 100 ? Math.round(((totalBytes * 8) / (durationMs / 1000) / 1e6) * 100) / 100 : null;
    return { samples, mbps, bytes: totalBytes, durationMs, error };
  }

  async upload(opts: SpeedRunOptions): Promise<ThroughputRun> {
    const startedAt = nowMs();
    // epoch-based deadline: the loop conditions below compare against Date.now()
    const deadline = Date.now() + opts.durationMs;
    const samples: ThroughputSample[] = [];
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let totalBytes = 0;
    let error: string | undefined;
    const payload = new Uint8Array(UPLOAD_CHUNK_BYTES); // zeros are fine for throughput

    const uploadWorker = async (): Promise<void> => {
      while (Date.now() < deadline && !controller.signal.aborted) {
        try {
          const res = await fetch(UPLOAD_URL, {
            method: 'POST',
            body: payload,
            signal: controller.signal,
            headers: { 'content-type': 'application/octet-stream' },
          });
          // drain to free the socket
          await res.arrayBuffer().catch(() => undefined);
          if (!res.ok) {
            error = `upload endpoint returned HTTP ${res.status}`;
            return;
          }
          totalBytes += UPLOAD_CHUNK_BYTES;
        } catch (err) {
          if (controller.signal.aborted) break;
          error = err instanceof Error ? err.message : String(err);
          return;
        }
      }
    };

    const sampler = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const elapsed = nowMs() - startedAt;
        if (elapsed <= 0) return;
        const mbps = (totalBytes * 8) / (elapsed / 1000) / 1e6;
        const sample: ThroughputSample = { t: Date.now(), bytes: totalBytes, mbps: Math.round(mbps * 100) / 100 };
        samples.push(sample);
        opts.onSample?.(sample, Math.min(100, Math.round((elapsed / opts.durationMs) * 100)));
        if (Date.now() >= deadline || controller.signal.aborted) {
          clearInterval(interval);
          resolve();
        }
      }, 250);
    });

    await Promise.all(Array.from({ length: opts.streams }, () => uploadWorker()));
    await sampler;
    opts.signal?.removeEventListener('abort', onExternalAbort);

    const durationMs = nowMs() - startedAt;
    const mbps = totalBytes > 0 && durationMs > 100 ? Math.round(((totalBytes * 8) / (durationMs / 1000) / 1e6) * 100) / 100 : null;
    return { samples, mbps, bytes: totalBytes, durationMs, error };
  }
}

export function defaultSpeedRequest(): Required<Pick<SpeedTestRequest, 'downloadStreams' | 'uploadStreams' | 'durationMs'>> {
  return { downloadStreams: 4, uploadStreams: 3, durationMs: 10_000 };
}
