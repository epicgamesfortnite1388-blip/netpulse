/**
 * ONE-OFF TRANSFORMATION — already applied. Kept for archaeology only.
 *
 * Running this again is a no-op (it is idempotent), but it is not a maintained
 * tool: the file paths below will drift, and the palette it removes is now
 * guarded by `assertNoRawPalette` in `scripts/assert-ui-contract.mjs`. If a raw
 * palette utility reappears, fix the component — do not extend this script.
 *
 * One-shot, idempotent palette unification.
 *
 * Every replacement below is an explicit (file, from, to) triple rather than a
 * regex sweep, so the intent of each colour change is reviewable and the script
 * cannot silently rewrite something it was not designed to touch.
 *
 * Three token families are legitimate in this product:
 *   1. semantic   --color-ok / -warn / -danger / -accent   (state)
 *   2. protocol   --color-proto-*                          (protocol identity)
 *   3. aether     --color-aether / -2 / -3                 (the app's own core)
 *
 * Anything else was a raw Tailwind palette colour. Those have no light-theme
 * counterpart, so they silently lost their meaning when the theme flipped.
 *
 * Special case: `.aether-stage` is a hard-coded dark gradient in BOTH themes
 * (identity.css), so text on that stage must be a fixed light ink. There the
 * hue moves to the border/background and the text stays `text-white/*`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const EDITS = {
  'apps/web/src/features/account/AccountPage.tsx': [
    ['className="text-sm text-red-400"', 'className="text-sm text-danger"'],
  ],

  'apps/web/src/components/EngineBadge.tsx': [
    [
      `const ENGINE_STYLES: Record<ProxyEngine, string> = {
  xray: 'text-sky-400 bg-sky-500/10',
  'sing-box': 'text-fuchsia-400 bg-fuchsia-500/10',
  v2ray: 'text-emerald-400 bg-emerald-500/10',
  hysteria: 'text-violet-400 bg-violet-500/10',
};`,
      `/**
 * One tint for every engine. The per-engine hues were decoration: the label
 * already names the runtime, and four arbitrary palette colours had no
 * light-theme counterpart, so the badge's tint vanished on a white card.
 */
const ENGINE_BADGE_CLASS = 'text-accent bg-accent-soft';`,
    ],
    ['${ENGINE_STYLES[label]}', '${ENGINE_BADGE_CLASS}'],
  ],

  'apps/web/src/features/nodes/NodeExplorerPage.tsx': [
    ["text-proto-sky bg-sky-500/10 border-sky-500/25", 'text-proto-sky bg-proto-sky/10 border-proto-sky/25'],
    ["text-proto-violet bg-violet-500/10 border-violet-500/25", 'text-proto-violet bg-proto-violet/10 border-proto-violet/25'],
    ["text-proto-orange bg-orange-500/10 border-orange-500/25", 'text-proto-orange bg-proto-orange/10 border-proto-orange/25'],
    ["text-proto-emerald bg-emerald-500/10 border-emerald-500/25", 'text-proto-emerald bg-proto-emerald/10 border-proto-emerald/25'],
    ["text-proto-cyan bg-cyan-500/10 border-cyan-500/25", 'text-proto-cyan bg-proto-cyan/10 border-proto-cyan/25'],
    ["text-proto-indigo bg-indigo-500/10 border-indigo-500/25", 'text-proto-indigo bg-proto-indigo/10 border-proto-indigo/25'],
    ["text-proto-amber bg-amber-500/10 border-amber-500/25", 'text-proto-amber bg-proto-amber/10 border-proto-amber/25'],
  ],

  'apps/web/src/features/vpn/engineMeta.ts': [
    // Third-party proxy cores and managed providers share one hue: the glyph is
    // an icon, and the name is already set beside it in text.
    ["glyph: 'from-sky-500/25 to-cyan-400/10 text-sky-300'", "glyph: 'from-accent/25 to-accent/10 text-accent'"],
    ["glyph: 'from-fuchsia-500/25 to-pink-400/10 text-fuchsia-300'", "glyph: 'from-accent/25 to-accent/10 text-accent'"],
    ["glyph: 'from-emerald-500/25 to-teal-400/10 text-emerald-300'", "glyph: 'from-accent/25 to-accent/10 text-accent'"],
    ["glyph: 'from-violet-500/25 to-indigo-400/10 text-violet-300'", "glyph: 'from-accent/25 to-accent/10 text-accent'"],
    // WireGuard was rose and OpenVPN was amber — i.e. the two native tunnels
    // were coloured exactly like the danger and warning states.
    ["glyph: 'from-rose-500/25 to-orange-400/10 text-rose-300'", "glyph: 'from-accent/25 to-accent/10 text-accent'"],
    ["glyph: 'from-amber-500/25 to-yellow-400/10 text-amber-300'", "glyph: 'from-accent/25 to-accent/10 text-accent'"],
    ["glyph: 'from-fuchsia-500/25 to-violet-400/10 text-fuchsia-300'", "glyph: 'from-accent/25 to-accent/10 text-accent'"],
    // Aether is the app's own core and keeps its own token family.
    ["glyph: 'from-violet-500/30 to-cyan-400/10 text-violet-300'", "glyph: 'from-aether/30 to-aether-2/10 text-aether'"],
  ],

  'apps/web/src/features/vpn/VpnPage.tsx': [
    ["glyph: 'from-emerald-500/25 to-teal-400/10 text-emerald-300'", "glyph: 'from-ok/25 to-ok/10 text-ok'"],
    [
      "id === 'wireguard' ? 'from-rose-500/25 to-orange-400/10 text-rose-300' : 'from-amber-500/25 to-yellow-400/10 text-amber-300',",
      "'from-accent/25 to-accent/10 text-accent',",
    ],
    ["glyph: 'from-slate-400/20 to-slate-300/5 text-slate-200'", "glyph: 'from-surface-3 to-transparent text-muted'"],
    ["glyph: 'from-violet-500/30 to-cyan-400/10 text-violet-200'", "glyph: 'from-aether/30 to-aether-2/10 text-aether'"],
    ["glyph: 'from-cyan-500/25 to-sky-400/10 text-cyan-300'", "glyph: 'from-accent/25 to-accent/10 text-accent'"],
  ],

  'apps/web/src/features/vpn/OverviewSurface.tsx': [
    ["glyph: 'from-violet-500/30 to-cyan-400/10 text-violet-200'", "glyph: 'from-aether/30 to-aether-2/10 text-aether'"],
    ["glyph: 'from-cyan-500/25 to-sky-400/10 text-cyan-300'", "glyph: 'from-accent/25 to-accent/10 text-accent'"],
    // `text-violet-200` is #ddd6fe: on a white card the Aether row's label was
    // effectively invisible. The token flips with the theme.
    ["'text-violet-200' : 'text-text'", "'text-aether' : 'text-text'"],
  ],

  'apps/web/src/features/vpn/TunnelSurface.tsx': [
    ['glyph="from-cyan-500/25 to-sky-400/10 text-cyan-300"', 'glyph="from-accent/25 to-accent/10 text-accent"'],
  ],

  'apps/web/src/features/vpn/AgentPathTrace.tsx': [
    [
      `  pending: 'border-white/8 bg-white/[0.02] text-faint',
  active: 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.18)]',
  ok: 'border-emerald-400/35 bg-emerald-400/10 text-emerald-100',
  failed: 'border-red-400/40 bg-red-400/10 text-red-100',`,
      `  pending: 'border-line bg-surface-2/40 text-faint',
  active: 'border-accent/40 bg-accent/10 text-accent shadow-[0_0_18px_var(--color-accent-soft)]',
  ok: 'border-ok/35 bg-ok/10 text-ok',
  failed: 'border-danger/40 bg-danger/10 text-danger',`,
    ],
    [
      `  pending: 'bg-white/8',
  active: 'bg-gradient-to-r from-cyan-300/70 to-cyan-300/20',
  ok: 'bg-emerald-400/45',
  failed: 'bg-red-400/40',`,
      `  pending: 'bg-line',
  active: 'bg-gradient-to-r from-accent/70 to-accent/20',
  ok: 'bg-ok/45',
  failed: 'bg-danger/40',`,
    ],
    ['truncate font-mono text-micro text-cyan-200/80', 'truncate font-mono text-micro text-accent/80'],
    [
      'absolute inset-x-1 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200 to-transparent',
      'absolute inset-x-1 top-0 h-px bg-gradient-to-r from-transparent via-accent to-transparent',
    ],
    ['absolute h-2 w-2 rounded-full bg-cyan-300/60', 'absolute h-2 w-2 rounded-full bg-accent/60'],
    ['h-1 w-1 rounded-full bg-cyan-200"', 'h-1 w-1 rounded-full bg-accent"'],
    ['absolute h-1 w-1 rounded-full bg-emerald-300/70', 'absolute h-1 w-1 rounded-full bg-ok/70'],
    [
      'absolute h-1.5 w-1.5 rounded-full bg-cyan-200 shadow-[0_0_8px_rgba(34,211,238,0.9)]',
      'absolute h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]',
    ],
  ],

  'apps/web/src/features/vpn/QuickConnectActivity.tsx': [
    // Stage tones: the icon and label already name the stage, so the colour only
    // has to answer "in flight / retried / failed / done".
    ["'memory-check': { label: 'MEMORY', tone: 'text-cyan-300' }", "'memory-check': { label: 'MEMORY', tone: 'text-accent' }"],
    ["'adaptive-plan': { label: 'POLICY', tone: 'text-violet-300' }", "'adaptive-plan': { label: 'POLICY', tone: 'text-aether' }"],
    ["'adaptive-choice': { label: 'DECISION', tone: 'text-violet-300' }", "'adaptive-choice': { label: 'DECISION', tone: 'text-aether' }"],
    ["'discovery-start': { label: 'SCAN', tone: 'text-cyan-300' }", "'discovery-start': { label: 'SCAN', tone: 'text-accent' }"],
    ["'candidate-probe': { label: 'PROBE', tone: 'text-cyan-300' }", "'candidate-probe': { label: 'PROBE', tone: 'text-accent' }"],
    ["'attempt-start': { label: 'ATTEMPT', tone: 'text-sky-300' }", "'attempt-start': { label: 'ATTEMPT', tone: 'text-accent' }"],
    ["'core-start': { label: 'CORE', tone: 'text-sky-300' }", "'core-start': { label: 'CORE', tone: 'text-accent' }"],
    ["'core-ready': { label: 'CORE READY', tone: 'text-sky-300' }", "'core-ready': { label: 'CORE READY', tone: 'text-ok' }"],
    ["'core-failed': { label: 'CORE FAILED', tone: 'text-red-300' }", "'core-failed': { label: 'CORE FAILED', tone: 'text-danger' }"],
    ["'dns-policy-active': { label: 'DNS POLICY', tone: 'text-cyan-300' }", "'dns-policy-active': { label: 'DNS POLICY', tone: 'text-accent' }"],
    ["'relay-check': { label: 'TUNNEL TEST', tone: 'text-amber-300' }", "'relay-check': { label: 'TUNNEL TEST', tone: 'text-warn' }"],
    ["'dns-response': { label: 'DNS RESPONSE', tone: 'text-cyan-300' }", "'dns-response': { label: 'DNS RESPONSE', tone: 'text-accent' }"],
    ["'verification-failed': { label: 'VERIFY FAILED', tone: 'text-red-300' }", "'verification-failed': { label: 'VERIFY FAILED', tone: 'text-danger' }"],
    ["'attempt-failed': { label: 'RETRY', tone: 'text-amber-300' }", "'attempt-failed': { label: 'RETRY', tone: 'text-warn' }"],
    ["connected: { label: 'VERIFIED', tone: 'text-emerald-300' }", "connected: { label: 'VERIFIED', tone: 'text-ok' }"],
    ["'route-active': { label: 'ROUTE ACTIVE', tone: 'text-emerald-300' }", "'route-active': { label: 'ROUTE ACTIVE', tone: 'text-ok' }"],
    ["complete: { label: 'COMPLETE', tone: 'text-emerald-300' }", "complete: { label: 'COMPLETE', tone: 'text-ok' }"],
    // bg-[#07121b] was a hard near-black: this panel became a black box on a
    // white page. It is a console surface, so it belongs on --color-surface-2.
    [
      'relative overflow-hidden rounded-xl border border-cyan-400/20 bg-[#07121b] shadow-[0_0_34px_rgba(34,211,238,0.07)]',
      'relative overflow-hidden rounded-[var(--np-r-3)] border border-line bg-surface-2 shadow-[0_0_34px_var(--color-accent-soft)]',
    ],
    ['bg-gradient-to-r from-transparent via-cyan-300/80 to-transparent', 'bg-gradient-to-r from-transparent via-accent/80 to-transparent'],
    [
      'rounded-lg border border-cyan-300/20 bg-cyan-300/10 text-cyan-200',
      'rounded-lg border border-accent/20 bg-accent/10 text-accent',
    ],
    ['rounded-full bg-emerald-400 ring-2 ring-[#07121b]', 'rounded-full bg-ok ring-2 ring-surface-2'],
    ['uppercase tracking-[0.16em] text-cyan-200/80', 'uppercase tracking-[0.16em] text-accent/80'],
    ['bg-gradient-to-b from-cyan-300/50 via-violet-300/20 to-transparent', 'bg-gradient-to-b from-accent/50 via-aether/20 to-transparent'],
    [
      "'bg-red-400/20 text-red-300' : done ? 'bg-emerald-400/15 text-emerald-300' : 'bg-[#07121b] text-cyan-200'",
      "'bg-danger/20 text-danger' : done ? 'bg-ok/15 text-ok' : 'bg-surface text-accent'",
    ],
    ['font-mono text-micro text-violet-200/80', 'font-mono text-micro text-aether/80'],
    ["failed ? 'text-red-200/90' : 'text-muted'", "failed ? 'text-danger/90' : 'text-muted'"],
    ['break-words font-mono text-micro text-red-200/70', 'break-words font-mono text-micro text-danger/70'],
    [
      'border border-cyan-300/40 bg-[#07121b]',
      'border border-accent/40 bg-surface',
    ],
    ['animate-spin text-cyan-200/70', 'animate-spin text-accent/70'],
    ['<ShieldCheck size={11} className="text-cyan-200" />', '<ShieldCheck size={11} className="text-accent" />'],
  ],

  'apps/web/src/features/vpn/AetherCore.tsx': [
    ["const hue = state === 'active' ? 'from-violet-500/70 via-cyan-400/50 to-fuchsia-400/40'", "const hue = state === 'active' ? 'from-aether/70 via-aether-2/50 to-aether-3/40'"],
    ["      : state === 'starting' ? 'from-amber-400/60 via-amber-300/40 to-yellow-200/30'", "      : state === 'starting' ? 'from-warn/60 via-warn/40 to-warn/30'"],
    ["      : state === 'down' ? 'from-red-500/50 via-red-400/30 to-rose-300/20'", "      : state === 'down' ? 'from-danger/50 via-danger/30 to-danger/20'"],
    ["        : 'from-indigo-500/50 via-violet-400/30 to-cyan-300/20';", "        : 'from-aether/50 via-aether/30 to-aether-2/20';"],
  ],

  // `.aether-stage` is permanently dark, so text stays a fixed light ink here
  // and only the hue-bearing border/background moves onto a token.
  'apps/web/src/features/vpn/AetherSurface.tsx': [
    [
      `  idle: 'border-violet-300/25 text-violet-100/85',
  starting: 'border-amber-300/35 text-amber-100/90',
  active: 'border-cyan-300/45 text-cyan-100',
  down: 'border-red-400/40 text-red-100/90',`,
      `  idle: 'border-aether/30 text-white/85',
  starting: 'border-warn/45 text-white/90',
  active: 'border-aether-2/50 text-white',
  down: 'border-danger/45 text-white/90',`,
    ],
    [
      "'border-cyan-300/60 bg-cyan-400/20 text-cyan-100'",
      "'border-aether-2/60 bg-aether-2/20 text-white'",
    ],
    [
      "'border-amber-300/70 bg-amber-400/10 text-amber-100 animate-pulse-dot'",
      "'border-warn/70 bg-warn/10 text-white animate-pulse-dot'",
    ],
    ["p.running ? 'text-amber-100' : 'text-white/45'", "p.running ? 'text-white/90' : 'text-white/45'"],
    ['from-violet-500/60 to-cyan-400/30', 'from-aether/60 to-aether-2/30'],
    ['absolute h-3 w-3 border-violet-300/35', 'absolute h-3 w-3 border-aether/35'],
    ['glyph="from-violet-500/30 to-cyan-400/10 text-violet-200"', 'glyph="from-aether/30 to-aether-2/10 text-white/85"'],
    ['uppercase tracking-[0.22em] text-violet-200/70', 'uppercase tracking-[0.22em] text-white/70'],
    [
      'aether-cta h-10 border-cyan-300/50 bg-cyan-400/15 px-5 text-cyan-50 hover:bg-cyan-400/25',
      'aether-cta h-10 border-aether-2/50 bg-aether-2/15 px-5 text-white hover:bg-aether-2/25',
    ],
    [
      'h-10 border-rose-300/40 bg-rose-500/15 px-5 text-rose-50 hover:bg-rose-500/25',
      'h-10 border-danger/40 bg-danger/15 px-5 text-white hover:bg-danger/25',
    ],
    ['rounded-lg bg-violet-500/10 text-violet-200', 'rounded-lg bg-aether/15 text-white/85'],
  ],
};

let touched = 0;
let applied = 0;
let missed = [];

for (const [file, pairs] of Object.entries(EDITS)) {
  let text = readFileSync(file, 'utf8');
  let changed = false;
  for (const [from, to] of pairs) {
    if (text.includes(from)) {
      text = text.split(from).join(to);
      applied += 1;
      changed = true;
    } else if (text.includes(to)) {
      // already applied — idempotent
    } else {
      missed.push(`${file} :: ${from.slice(0, 70)}`);
    }
  }
  if (changed) {
    writeFileSync(file, text);
    touched += 1;
  }
}

console.log(`files written: ${touched}`);
console.log(`replacements applied: ${applied}`);
if (missed.length) {
  console.log(`\nNOT FOUND (${missed.length}) — inspect these:`);
  for (const m of missed) console.log('  ' + m);
}
