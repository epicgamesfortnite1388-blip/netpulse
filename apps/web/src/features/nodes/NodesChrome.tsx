import { Cpu, Download, Radar, Server, X } from 'lucide-react';
import { Link, NavLink } from 'react-router';

import type { ReactNode } from 'react';

/**
 * The shared sub-navigation for the node area.
 *
 * Explorer, Sources, Engines and one node's detail page are views over the same
 * dataset, so they carry one persistent nav strip. Without it the four read as
 * unrelated pages, and the only way back from a detail page was browser back.
 * These are the same destinations the sidebar's "Nodes" section groups.
 *
 * The shape deliberately differs from the Tabs / Segmented strips used *inside*
 * these pages (a rounded-full nav vs rounded-xl content tabs) so the page level
 * and the content level never blur together.
 */
const NODES_NAV: { to: string; label: string; icon: ReactNode }[] = [
  // No `end`: the Explorer stays lit on /nodes/:id, because a node's detail page
  // *is* the Explorer with one row opened.
  { to: '/nodes', label: 'Explorer', icon: <Radar size={13} /> },
  { to: '/nodes-sources', label: 'Sources', icon: <Download size={13} /> },
  { to: '/engines', label: 'Engines', icon: <Cpu size={13} /> },
];

export function NodesNav({ current }: { current?: string }) {
  return (
    <nav
      aria-label="Node pages"
      className="mb-5 flex flex-wrap items-center gap-1 rounded-full border border-line bg-surface p-1"
    >
      <span className="hidden pl-2.5 pr-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint sm:block">
        Nodes
      </span>
      {NODES_NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            `inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors ${
              isActive ? 'bg-accent-soft text-accent-strong' : 'text-muted hover:bg-surface-2 hover:text-text'
            }`
          }
        >
          {item.icon}
          {item.label}
        </NavLink>
      ))}
      {/* Which node is open, shown on the detail page only — it keeps the strip's
          position legible instead of looking like a dead end. */}
      {current && (
        <span className="ml-auto flex min-w-0 items-center gap-1.5 rounded-full bg-accent-soft py-1 pl-3 pr-1.5 text-sm text-accent-strong">
          <Server size={13} className="shrink-0" />
          <span className="max-w-[14rem] truncate" title={current}>
            {current}
          </span>
          <Link
            to="/nodes"
            className="rounded-full p-1 transition-colors hover:bg-accent/20"
            title="Return to the node list"
            aria-label="Return to the node list"
          >
            <X size={12} />
          </Link>
        </span>
      )}
    </nav>
  );
}
