import { jitterMs, median, lossPct, round } from '@netpulse/shared';

export interface ParsedPingOutput {
  samples: { seq: number; ok: boolean; ms: number | null; error?: string }[];
  sent: number | null;
  received: number | null;
  lossPct: number | null;
  min: number | null;
  avg: number | null;
  max: number | null;
  /** 'full' = per-sample latencies + statistics parsed; 'partial' = statistics only */
  quality: 'full' | 'partial';
}

/**
 * Locale-tolerant parser for Windows ping.exe output.
 *
 * Strategy: reply lines are identified by the presence of "TTL" (which
 * survives Windows localization), latency is extracted from a
 * `<label>=<n>ms|мс` pattern (English time=, German Zeit=, Russian время=).
 * The statistics line carries three `= <n>ms` values in the fixed order
 * Minimum, Maximum, Average.
 */
export function parseWindowsPing(stdout: string, totalExpected: number): ParsedPingOutput {
  const lines = stdout.split(/\r?\n/);
  const samples: ParsedPingOutput['samples'] = [];
  let seq = 0;

  const msFromLine = (line: string): number | null => {
    const lt = line.match(/<\s*(\d+)\s*(?:ms|мс)/i);
    if (lt) return 1; // "<1ms" — report the lower bound
    const m = line.match(/=\s*(\d+)\s*(?:ms|мс)/i);
    return m ? Number(m[1]) : null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/TTL/i.test(line)) {
      seq += 1;
      samples.push({ seq, ok: true, ms: msFromLine(line) });
      continue;
    }
    if (
      /timed out|unreachable|failure|failed|berschreit|превыш|недоступен|сбой|истек/i.test(line) &&
      !/%/.test(line)
    ) {
      seq += 1;
      samples.push({ seq, ok: false, ms: null, error: 'no reply' });
      continue;
    }
  }

  // Statistics: last line containing three "= <n>ms" triples (min, max, avg)
  let min: number | null = null;
  let avg: number | null = null;
  let max: number | null = null;
  let loss: number | null = null;

  for (const rawLine of [...lines].reverse()) {
    const lossMatch = rawLine.match(/\((\d+)%\s*(?:loss|потерян)/i) ?? rawLine.match(/(\d+)%/);
    if (lossMatch && loss === null) {
      loss = Number(lossMatch[1]);
    }
    const triple = rawLine.match(/=\s*(\d+)\s*(?:ms|мс)[^\d=]+=\s*(\d+)\s*(?:ms|мс)[^\d=]+=\s*(\d+)\s*(?:ms|мс)/i);
    if (triple && min === null) {
      min = Number(triple[1]);
      max = Number(triple[2]);
      avg = Number(triple[3]);
    }
  }

  const okSamples = samples.filter((s) => s.ok);
  const receivedSamples = okSamples.length;
  const sent =
    loss !== null && receivedSamples > 0
      ? Math.max(samples.length, Math.round(receivedSamples / (1 - loss / 100)))
      : samples.length || totalExpected;
  const received =
    loss !== null
      ? Math.max(receivedSamples, Math.round(sent * (1 - loss / 100)))
      : receivedSamples;

  const finalLoss = loss !== null ? loss : lossPct(sent, received);
  const latencies = okSamples.map((s) => s.ms).filter((v): v is number => v != null);

  return {
    samples,
    sent,
    received,
    lossPct: round(finalLoss, 1),
    min: min ?? (latencies.length ? Math.min(...latencies) : null),
    avg: avg ?? (latencies.length ? round(latencies.reduce((a, b) => a + b, 0) / latencies.length, 1) : null),
    max: max ?? (latencies.length ? Math.max(...latencies) : null),
    quality: samples.every((s) => s.ok === false || s.ms != null) && samples.length > 0 ? 'full' : 'partial',
  };
}

/** Best-effort parser for Linux/macOS ping output (English locales). */
export function parseUnixPing(stdout: string, totalExpected: number): ParsedPingOutput {
  const lines = stdout.split(/\r?\n/);
  const samples: ParsedPingOutput['samples'] = [];
  let seq = 0;
  for (const rawLine of lines) {
    const reply = rawLine.match(/time[=<]\s*([\d.]+)\s*ms/i);
    if (reply) {
      seq += 1;
      samples.push({ seq, ok: true, ms: Number(reply[1]) });
      continue;
    }
    if (/timed out|unreachable|100% packet loss|Request timeout/i.test(rawLine)) {
      seq += 1;
      samples.push({ seq, ok: false, ms: null, error: 'no reply' });
    }
  }
  const lossMatch = stdout.match(/([\d.]+)%\s*packet loss/i);
  const latencies = samples.filter((s) => s.ok && s.ms != null).map((s) => s.ms!);
  const received = latencies.length;
  const sent = samples.length || totalExpected;
  const statValues = [...stdout.matchAll(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/g)];
  const stats = statValues[statValues.length - 1];
  return {
    samples,
    sent,
    received: lossMatch ? Math.round((sent * (100 - Number(lossMatch[1]))) / 100) : received,
    lossPct: lossMatch ? Number(lossMatch[1]) : lossPct(sent, received),
    min: stats ? Number(stats[1]) : (latencies.length ? Math.min(...latencies) : null),
    avg: stats ? Number(stats[2]) : (latencies.length ? round(latencies.reduce((a, b) => a + b, 0) / latencies.length, 1) : null),
    max: stats ? Number(stats[3]) : (latencies.length ? Math.max(...latencies) : null),
    quality: samples.length > 0 ? 'full' : 'partial',
  };
}

/** Derive median/jitter/median from sample latencies, filling missing stats. */
export function finalizePingStats(parsed: ParsedPingOutput): {
  medianVal: number | null;
  jitterVal: number | null;
  min: number | null;
  avg: number | null;
  max: number | null;
} {
  const latencies = parsed.samples
    .filter((s) => s.ok && s.ms != null)
    .map((s) => s.ms as number);
  return {
    medianVal: median(latencies),
    jitterVal: jitterMs(latencies) === null ? null : round(jitterMs(latencies) as number, 2),
    min: parsed.min ?? (latencies.length ? Math.min(...latencies) : null),
    avg: parsed.avg ?? (latencies.length ? round(latencies.reduce((a, b) => a + b, 0) / latencies.length, 1) : null),
    max: parsed.max ?? (latencies.length ? Math.max(...latencies) : null),
  };
}
