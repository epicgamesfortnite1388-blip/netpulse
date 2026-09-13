import { Info, MapPinOff } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';

import type { ReactNode } from 'react';

/**
 * Why a node/pin shows Unknown instead of a location. Single source of truth
 * for every surface that renders geography — the map never shows a confident
 * lie, so the empty field must read as honesty, not missing data.
 */
export type GeoStatusReason = 'known' | 'anycast' | 'edge_fabric' | 'lookup_failed' | 'pending';

interface GeoStatusCopy {
  /** Compact label for table cells / badges. */
  short: string;
  /** Panel title. */
  title: string;
  /** One-paragraph explanation. */
  detail: string;
}

export const GEO_STATUS_COPY: Record<GeoStatusReason, GeoStatusCopy> = {
  known: {
    short: 'GeoIP',
    title: 'Location from IP evidence',
    detail: 'City-level GeoIP estimate from this node’s resolved public IP — approximate, never exact.',
  },
  anycast: {
    short: 'Anycast',
    title: 'No single location (anycast IP)',
    detail:
      'This IP is announced from many datacenters worldwide at once, so it has no single true location. GeoIP answers for it are artifacts — the node is shown as Unknown instead of a confident lie.',
  },
  edge_fabric: {
    short: 'Edge network',
    title: 'No location shown (global edge network)',
    detail:
      'This IP belongs to a provider’s worldwide edge fabric (Cloudflare, Google, AWS, Azure…). GeoIP would report the provider’s registration office, not where your traffic actually exits.',
  },
  lookup_failed: {
    short: 'No data',
    title: 'Location could not be determined',
    detail:
      'A geolocation attempt ran but no location could be established for this node’s IP. Unknown is shown rather than a guess; the geo worker retries periodically.',
  },
  pending: {
    short: 'Pending',
    title: 'Location lookup pending',
    detail: 'This node has not been geolocated yet — new nodes are resolved in bounded background batches, oldest first.',
  },
};

/** Derive the reason when a caller's data predates the field. */
export function geoReasonOf(
  reason: GeoStatusReason | null | undefined,
  hasCoords: boolean,
): GeoStatusReason {
  if (reason != null) return reason;
  return hasCoords ? 'known' : 'pending';
}

/**
 * Compact badge for list rows: the country cell renders `DE · Frankfurt` for
 * geo-verified nodes, or a refused-reason badge (hover for the explanation)
 * instead of a bare "—" that looks like missing data.
 */
export function GeoStatusBadge({
  reason,
  children,
}: {
  reason: GeoStatusReason;
  /** Optional extra content next to the badge (e.g. a latency figure). */
  children?: ReactNode;
}) {
  const copy = GEO_STATUS_COPY[reason];
  const tone = reason === 'anycast' || reason === 'edge_fabric' ? 'accent' : 'neutral';
  const badge = (
    <Badge tone={tone}>
      <MapPinOff size={10} />
      {copy.short}
    </Badge>
  );
  return (
    <div className="flex items-center gap-1.5">
      <Tooltip content={<GeoTooltipBody reason={reason} />}>{badge}</Tooltip>
      {children}
    </div>
  );
}

/** Full explainer body — reused by tooltips and the detail-page panel. */
export function GeoTooltipBody({ reason }: { reason: GeoStatusReason }) {
  const copy = GEO_STATUS_COPY[reason];
  return (
    <div className="flex items-start gap-2">
      <Info size={13} className="mt-0.5 shrink-0 text-accent" />
      <div>
        <p className="font-medium">{copy.title}</p>
        <p className="mt-0.5 text-muted">{copy.detail}</p>
      </div>
    </div>
  );
}
