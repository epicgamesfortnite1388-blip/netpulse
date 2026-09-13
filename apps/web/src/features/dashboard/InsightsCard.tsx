import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

import { Card, CardBody, CardHeader } from '@/components/ui/Card';

import type { PingResult } from '@shared/models/network';
import type { NetworkStatus } from '@shared/models/network';
import { latencyScore } from '@shared/score/engine';

export interface Insight {
  level: 'ok' | 'info' | 'warn';
  message: string;
}

/** All insights are derived from real measurements only — never invented. */
export function deriveInsights(
  status: NetworkStatus | undefined,
  lastPing: PingResult | null,
  extra: { bestDnsMs?: number | null; downloadMbps?: number | null; uploadMbps?: number | null } = {},
): Insight[] {
  const insights: Insight[] = [];

  if (status && !status.online) {
    insights.push({ level: 'warn', message: 'You appear to be offline — the TCP probe to 1.1.1.1:443 failed.' });
    return insights;
  }

  if (status?.latencyTcpMs != null) {
    const s = latencyScore(status.latencyTcpMs);
    if (s >= 85) {
      insights.push({
        level: 'ok',
        message: `Latency is excellent — ${status.latencyTcpMs.toFixed(1)} ms to 1.1.1.1 over TCP.`,
      });
    } else if (s <= 40) {
      insights.push({
        level: 'warn',
        message: `Latency is high (${status.latencyTcpMs.toFixed(1)} ms). Run the ping suite to see jitter and loss detail.`,
      });
    } else {
      insights.push({
        level: 'info',
        message: `Latency is ${status.latencyTcpMs.toFixed(1)} ms to 1.1.1.1 over TCP.`,
      });
    }
  }

  if (status?.ipv6.available) {
    insights.push({
      level: 'info',
      message: 'IPv6 is available on this network — use Route Compare to see whether IPv4 or IPv6 is faster.',
    });
  } else if (status && !status.ipv6.available) {
    insights.push({
      level: 'info',
      message: 'IPv6 is not reachable from this network.',
    });
  }

  if (lastPing) {
    if (lastPing.lossPct > 0) {
      insights.push({
        level: 'warn',
        message: `Last ping run lost ${lastPing.lossPct}% of packets to ${lastPing.target}.`,
      });
    }
    if (lastPing.jitterMs != null && lastPing.jitterMs > 5) {
      insights.push({
        level: 'warn',
        message: `Jitter was ${lastPing.jitterMs.toFixed(1)} ms in the last run — noticeable variance in latency.`,
      });
    }
  } else {
    insights.push({
      level: 'info',
      message: 'Run a quick ping test to measure jitter and packet loss.',
    });
  }

  if (extra.bestDnsMs != null) {
    insights.push(
      extra.bestDnsMs <= 30
        ? { level: 'ok', message: `Your best tested DNS resolver responds in ${extra.bestDnsMs.toFixed(1)} ms.` }
        : extra.bestDnsMs > 80
          ? { level: 'warn', message: `Your best tested DNS resolver is slow (${extra.bestDnsMs.toFixed(1)} ms) — try the DNS benchmark to compare providers.` }
          : { level: 'info', message: `Best tested DNS resolver latency: ${extra.bestDnsMs.toFixed(1)} ms.` },
    );
  } else {
    insights.push({
      level: 'info',
      message: 'Run a DNS benchmark to measure resolver latency and detect leaks.',
    });
  }

  if (extra.downloadMbps != null) {
    insights.push({
      level: 'info',
      message: `Last measured throughput: ${extra.downloadMbps.toFixed(1)} Mbps down${
        extra.uploadMbps != null ? ` / ${extra.uploadMbps.toFixed(1)} Mbps up` : ''
      }.`,
    });
  }

  return insights;
}

const ICONS = {
  ok: <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" />,
  info: <Info size={14} className="mt-0.5 shrink-0 text-accent" />,
  warn: <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />,
};

export function InsightsCard({ insights }: { insights: Insight[] }) {
  return (
    <Card>
      <CardHeader title="Insights" subtitle="Generated from your live measurements" />
      <CardBody>
        <ul className="space-y-2.5">
          {insights.map((insight, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[13px] leading-relaxed text-muted">
              {ICONS[insight.level]}
              <span>{insight.message}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
