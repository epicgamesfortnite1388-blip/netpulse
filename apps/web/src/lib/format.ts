export function fmtMs(value: number | null | undefined, digits = 1): string {
  if (value == null) return '—';
  return `${value.toFixed(digits)} ms`;
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null) return '—';
  return `${value.toFixed(digits)}%`;
}

export function fmtMbps(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toFixed(1)} Mbps`;
}

export function fmtScore(value: number | null | undefined): string {
  if (value == null) return '—';
  return String(Math.round(value));
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
