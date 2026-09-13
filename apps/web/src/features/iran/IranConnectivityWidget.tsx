import { useQuery } from '@tanstack/react-query';
import { Expand, Flag, Shield } from 'lucide-react';
import { useNavigate } from 'react-router';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/api';

import type { IranSession } from '@netpulse/shared';

export function IranConnectivityWidget() {
  const navigate = useNavigate();
  const sessionsQuery = useQuery({
    queryKey: ['iran', 'sessions', 'widget'],
    queryFn: () => api.get<{ sessions: IranSession[] }>('/iran/sessions?limit=1'),
    refetchInterval: 30_000,
  });

  const latest = sessionsQuery.data?.sessions[0] ?? null;
  const summary = latest?.summary ?? null;
  const connections = latest?.connections ?? [];

  return (
    <Card>
      <CardHeader
        title="Iran connectivity"
        subtitle="Reachability across your connections"
        icon={<Flag size={15} className="text-accent" />}
        actions={
          <Button variant="primary" size="sm" onClick={() => navigate('/iran')}>
            <Expand size={13} />
            Open analysis
          </Button>
        }
      />
      <CardBody>
        {!summary ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted">Run the Iran connectivity test to see reachability across your connections.</p>
            <Button size="sm" onClick={() => navigate('/iran')}>
              Run test
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <Shield size={12} className={connections.length > 1 ? 'text-accent' : 'text-faint'} />
                {connections.length} connection{connections.length === 1 ? '' : 's'} tested
              </span>
              <Badge tone="accent">
                {summary.reachable}/{summary.total} reachable
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">Health</p>
                <p className="text-lg font-semibold text-text">{summary.healthScore}/100</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">Possible filtering</p>
                <p className="text-lg font-semibold text-warn">{summary.possibleFiltering}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">Network failures</p>
                <p className="text-lg font-semibold text-danger">{summary.networkFailures}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">Best profile</p>
                <p className="truncate text-sm font-semibold text-accent-strong" title={summary.bestConnectionName ?? undefined}>
                  {summary.bestConnectionName ?? '—'}
                </p>
              </div>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}