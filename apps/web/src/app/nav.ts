/**
 * Navigation model for the redesigned shell.
 *
 * The old shell flattened 25 destinations into 8 groups in one 240px column,
 * which made the sidebar scroll on a 900px window and turned every screen into
 * a control panel. The new model has two tiers:
 *
 *   - a 76px rail with five destinations (one per product capability)
 *   - a 226px context column that lists only the routes of the ACTIVE section
 *
 * Every routed screen belongs to exactly one section. `resolveSection` derives
 * the section from the URL (longest matching prefix), so a detail route like
 * /nodes/:id still lights up "Connection" without a special case in the shell.
 *
 * Nothing here changes routing: all paths are the existing router paths.
 */
import {
  Activity,
  Bot,
  Brain,
  Cloud,
  CloudCog,
  Cpu,
  Download,
  Flag,
  FlaskConical,
  Gamepad2,
  Gauge,
  Globe,
  HeartPulse,
  History,
  Radar,
  Radio,
  Route,
  Satellite,
  Server,
  Settings,
  Shield,
  Stethoscope,
  Waves,
} from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

export interface NavLinkDef {
  to: string;
  label: string;
  icon: LucideIcon;
  group: string;
  /** Optional short suffix shown in the context column, e.g. a discipline. */
  note?: string;
}

export interface NavSection {
  id: string;
  /** Heading in the context column. */
  label: string;
  /** 1-2 word label under the rail icon. */
  railLabel: string;
  /** Where the rail icon navigates. */
  to: string;
  icon: LucideIcon;
  links: NavLinkDef[];
  /** One honest line describing the section, shown at the top of the column. */
  blurb: string;
}

export const SECTIONS: NavSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    railLabel: 'Overview',
    to: '/',
    icon: Gauge,
    blurb: 'Network state, evidence and live topology.',
    links: [
      { to: '/', label: 'Dashboard', icon: Gauge, group: 'State' },
      { to: '/map', label: 'Live Map', icon: Globe, group: 'State' },
      { to: '/mission', label: 'Mission Control', icon: Satellite, group: 'State' },
      { to: '/overdrive', label: 'Mission Overdrive', icon: FlaskConical, group: 'State' },
    ],
  },
  {
    id: 'connect',
    label: 'Connection',
    railLabel: 'Connect',
    to: '/vpn',
    icon: Shield,
    blurb: 'Engines, profiles and configuration inventory.',
    links: [
      { to: '/vpn', label: 'VPN & engines', icon: Shield, group: 'Connection' },
      { to: '/servers', label: 'Servers', icon: Server, group: 'Connection' },
      { to: '/optimizer', label: 'Optimizer', icon: Activity, group: 'Connection' },
      { to: '/nodes', label: 'Node Explorer', icon: Radar, group: 'Inventory' },
      { to: '/nodes-sources', label: 'Sources', icon: Download, group: 'Inventory' },
      { to: '/engines', label: 'Engines', icon: Cpu, group: 'Inventory' },
    ],
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    railLabel: 'NANI',
    to: '/nani',
    icon: Brain,
    blurb: 'Investigations, hypotheses and recorded evidence.',
    links: [
      { to: '/nani', label: 'NANI', icon: Brain, group: 'Investigation' },
      { to: '/copilot', label: 'Copilot', icon: Bot, group: 'Investigation' },
      { to: '/history', label: 'History', icon: History, group: 'Records' },
      { to: '/events', label: 'Events', icon: Radio, group: 'Records' },
    ],
  },
  {
    id: 'diagnose',
    label: 'Diagnostics',
    railLabel: 'Diagnose',
    to: '/diagnostics',
    icon: HeartPulse,
    blurb: 'Measured tests. Nothing here is inferred.',
    links: [
      { to: '/diagnostics', label: 'Quick Check', icon: HeartPulse, group: 'Network tests' },
      { to: '/speed-test', label: 'Speed Test', icon: Waves, group: 'Network tests' },
      { to: '/dns', label: 'DNS', icon: Radar, group: 'Network tests' },
      { to: '/ip', label: 'IP & leaks', icon: Globe, group: 'Network tests' },
      { to: '/routes', label: 'Routes', icon: Route, group: 'Network tests' },
      { to: '/cloudflare', label: 'Cloudflare', icon: Cloud, group: 'Edge' },
      { to: '/gaming', label: 'Gaming', icon: Gamepad2, group: 'Edge' },
      { to: '/iran', label: 'Iran Connectivity', icon: Flag, group: 'Edge' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    railLabel: 'System',
    to: '/settings',
    icon: Settings,
    blurb: 'Preferences, account and installation health.',
    links: [
      { to: '/settings', label: 'Settings', icon: Settings, group: 'System' },
      { to: '/account', label: 'Account', icon: CloudCog, group: 'System' },
      { to: '/health', label: 'System Health', icon: Stethoscope, group: 'System' },
    ],
  },
];

/** Resolve the section for a URL. Longest matching route prefix wins. */
export function resolveSection(pathname: string): NavSection {
  // /nodes/:id is a child of the Node Explorer and is not itself a nav row.
  const effective = pathname.startsWith('/nodes/') ? '/nodes' : pathname;
  let best: { section: NavSection; length: number } | null = null;
  for (const section of SECTIONS) {
    for (const link of section.links) {
      const exact = effective === link.to;
      const child = link.to !== '/' && effective.startsWith(`${link.to}/`);
      if (!exact && !child) continue;
      if (!best || link.to.length > best.length) best = { section, length: link.to.length };
    }
  }
  return best?.section ?? SECTIONS[0]!;
}

/** Is a nav row the current page? `end` semantics for the dashboard root. */
export function isCurrentLink(to: string, pathname: string): boolean {
  if (to === '/') return pathname === '/';
  if (to === '/nodes' && pathname.startsWith('/nodes/')) return true;
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Group the section's links while preserving their declared order. */
export function groupedLinks(section: NavSection): { group: string; links: NavLinkDef[] }[] {
  const out: { group: string; links: NavLinkDef[] }[] = [];
  for (const link of section.links) {
    const last = out[out.length - 1];
    if (last && last.group === link.group) last.links.push(link);
    else out.push({ group: link.group, links: [link] });
  }
  return out;
}
