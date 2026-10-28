import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataList, DataRow, Notice, Panel, Section } from '@/components/ui/Surface';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';

import { PROFILE_NAME_PREFIX } from '@netpulse/shared';
import {
  evidenceSummary,
  failingProvisionedNodes,
  refreshProvisionedCredentials,
} from './provisionedRepair';

import type { ProvisionedRefreshResult } from './provisionedRepair';
import type { NodeView } from '@netpulse/shared';

/**
 * Subscription profiles the server may no longer accept — with a one-click fix.
 *
 * Mounted once, in the VPN shell, so every engine surface can see it. The reason
 * it lives here rather than in Account: a subscriber whose credential was
 * re-issued never goes to Account. Their tunnel just stops working, the node
 * still looks healthy in every list, and nothing on screen says why. This card
 * is where that user is standing.
 *
 * What it claims and what it does not:
 *
 *  - It detects provisioned profiles that have never passed, or stopped passing,
 *    a probe, and states that as the observation.
 *  - It does NOT announce "your credential expired". A failing probe has several
 *    causes and the app cannot distinguish them locally. The verdict comes from
 *    the server: a refresh that replaces the stored credential proves it was
 *    stale, and one that returns the identical credential says so instead.
 *  - It is silent unless there is something to act on, and it does not touch a
 *    provisioned profile that is passing probes.
 */

const SUSPECT_QUERY_KEY = ['nodes', 'provisioned-repair'] as const;

/** How many provisioned profiles to look at (the API caps a page at its own ceiling). */
const SUSPECT_LIMIT = 200;

function nodeStatusLine(node: NodeView): string {
  if (node.successCount === 0) {
    return node.testCount === 0 ? 'never tested through a core' : `no successful probe in ${node.testCount} attempt(s)`;
  }
  return `failing now — ${node.consecutiveFailures} consecutive failure(s)`;
}

function toneFor(result: ProvisionedRefreshResult): 'ok' | 'warn' | 'danger' {
  if (result.outcome === 'unavailable') return 'danger';
  if (result.outcome === 'credential-replaced' && (result.probed?.carried ?? 0) > 0) return 'ok';
  return 'warn';
}

export function ProvisionedRepairCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [result, setResult] = useState<ProvisionedRefreshResult | null>(null);

  const query = useQuery({
    queryKey: SUSPECT_QUERY_KEY,
    queryFn: () =>
      api.get<{ nodes: NodeView[]; total: number }>(
        `/nodes?limit=${SUSPECT_LIMIT}&search=${encodeURIComponent(PROFILE_NAME_PREFIX)}`,
      ),
    // The stored marker is a filter, not a guarantee: the API search is a
    // substring match over the whole row, so the prefix test is re-applied here
    // before anything is called a subscription profile.
    select: (data) => failingProvisionedNodes(data.nodes ?? []),
    refetchInterval: 30_000,
  });

  const suspects = query.data ?? [];

  const refresh = useMutation({
    mutationFn: () => refreshProvisionedCredentials(suspects.map((n) => n.id)),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      if (r.outcome === 'credential-replaced') {
        toast('ok', 'Credential refreshed', 'The app replaced a credential the server had re-issued.');
      } else if (r.outcome === 'unavailable') {
        toast('error', 'Could not refresh', r.message);
      }
    },
    onError: (err) => {
      setResult(null);
      toast('error', 'Could not refresh', err instanceof Error ? err.message : undefined);
    },
  });

  // Nothing failing, and nothing to report about a refresh that already ran.
  if (suspects.length === 0 && !result) return null;

  return (
    <Section
      variant="flat"
      title="Subscription profiles that are not passing"
      icon={<KeyRound size={15} />}
      subtitle="These came from your NetPulse subscription. A probe that never passes can mean the server re-issued your credential, the server is down, or this network blocks it — the refresh below asks the server which credential it issues now and reports what it found."
      actions={
        <Badge tone={suspects.length > 0 ? 'warn' : 'ok'}>
          {suspects.length > 0 ? `${suspects.length} to check` : 'none failing'}
        </Badge>
      }
    >
      {suspects.length > 0 && (
        <DataList className="rounded-xl border border-line bg-surface px-4">
          {suspects.map((node) => (
            <DataRow
              key={node.id}
              leading={<span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />}
              title={<span className="text-sm text-text">{node.label}</span>}
              subtitle={
                <span className="text-micro text-faint">
                  {node.protocolLabel} · {nodeStatusLine(node)}
                  {node.lastProxyMs != null ? ` · last measured ${node.lastProxyMs} ms` : ''}
                </span>
              }
            />
          ))}
        </DataList>
      )}

      {suspects.length > 0 && (
        <p className="mt-2 text-micro leading-relaxed text-faint">
          Observed: {evidenceSummary(suspects)}. Nothing is deleted or renamed by a refresh — the app asks your subscription for the configs it
          currently issues and replaces a stored credential only when the server&apos;s differs.
        </p>
      )}

      <Panel className="mt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => refresh.mutate()} loading={refresh.isPending} disabled={refresh.isPending}>
            <RefreshCw size={13} />
            {refresh.isPending ? 'Refreshing…' : 'Refresh from subscription'}
          </Button>
          <span className="text-micro text-faint">
            Uses the account this device is signed in to; sign-in lives on the Account page.
          </span>
        </div>
      </Panel>

      {result && (
        <Notice tone={toneFor(result)} className="mt-3">
          {result.message}
        </Notice>
      )}
    </Section>
  );
}
