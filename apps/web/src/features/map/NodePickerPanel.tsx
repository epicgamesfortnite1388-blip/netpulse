import { CheckCircle2, ExternalLink, MapPin, X } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Metric } from '@/components/ui/Metric';

import { pickerNetwork, pickerPlace, readPing, selectionConfirmation } from './nodePicker';

import type { NodeView } from '@netpulse/shared';

/**
 * The positive half of "hide the config": pick a server by where it is and how
 * it feels, and get it into the engine without the credential ever crossing to
 * the client.
 *
 * The panel is deliberately a *decision* surface, not a detail page: place,
 * network, ping and its basis, score/reliability, then one primary action. The
 * node's full record stays one click away on the existing detail page — nothing
 * that exists today is replaced or hidden by this component.
 *
 * Selection goes through POST /vpn/profiles/from-node, which rebuilds the share
 * link server-side. This component never renders a link, host, port, protocol
 * parameter or credential, and the confirmation text is assembled from the same
 * place/ping the panel already showed so it cannot become a partial config dump.
 */

export interface PickerConfirmation {
  profileName: string;
  node: NodeView;
}

export function NodePickerPanel({
  node,
  busy,
  confirmation,
  onUse,
  onOpenDetails,
  onClose,
}: {
  node: NodeView;
  /** True while the from-node request for THIS node is in flight. */
  busy: boolean;
  confirmation: PickerConfirmation | null;
  onUse: (node: NodeView) => void;
  onOpenDetails: (node: NodeView) => void;
  onClose: () => void;
}) {
  const ping = readPing(node);
  const network = pickerNetwork(node);
  const place = pickerPlace(node);
  const confirmed = confirmation && confirmation.node.id === node.id ? selectionConfirmation({ profileName: confirmation.profileName, node, ping }) : null;

  return (
    <Card data-testid="node-picker">
      <CardHeader
        title="Pick a location"
        subtitle="Choose by place and ping. The connection details never come to this window."
        actions={
          <button type="button" onClick={onClose} aria-label="Close the location picker" className="rounded p-1 text-muted hover:text-text">
            <X size={14} />
          </button>
        }
      />
      <CardBody>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <MapPin size={14} className="shrink-0 text-accent" />
              <h3 className="truncate text-sm font-semibold text-text">{node.remark ?? node.label}</h3>
              <Badge tone={node.status === 'healthy' ? 'ok' : node.status === 'degraded' ? 'warn' : node.status === 'failed' ? 'danger' : 'neutral'}>
                {node.status}
              </Badge>
            </div>
            <p className="mt-1 text-mini text-muted">{place}</p>
            {network ? <p className="text-micro text-faint">{network}</p> : null}
          </div>
        </div>

        {/* Ping is the number the user is choosing on, so it gets the largest
            type on the panel — and when there is no measurement it says so in
            words instead of rendering a placeholder number. */}
        <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
          <div className="text-micro font-semibold uppercase tracking-[0.14em] text-faint">Ping</div>
          <div className={`mt-1 font-mono text-xl ${ping.ms == null ? 'text-faint' : ping.degraded ? 'text-warn' : 'text-text'}`}>{ping.value}</div>
          <div className="text-micro text-faint">{ping.basisLabel}</div>
        </div>

        {/* The ping block above already states the median and its basis, so the
            grid carries only the two measures it does not: how often this node
            works, and how the catalogue rates it. */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Metric label="Reliability" value={node.reliabilityPct} unit="pct" />
          <Metric label="Score" value={node.score} unit="raw" />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" loading={busy} onClick={() => onUse(node)}>
            {busy ? 'Connecting…' : 'Use this location'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenDetails(node)} title="Open the full node record">
            <ExternalLink size={14} />
            Open node details
          </Button>
        </div>

        {confirmed ? (
          <div role="status" data-testid="picker-confirmation" className="mt-4 rounded-lg border border-ok/30 bg-ok/10 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-ok">
              <CheckCircle2 size={15} />
              {confirmed.title}
            </div>
            <dl className="mt-2 space-y-1">
              {confirmed.lines.map((line) => (
                <div key={line} className="text-micro text-muted">
                  {line}
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}