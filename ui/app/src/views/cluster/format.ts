// Copyright OBSESC Authors
//
// Tiny display formatters shared across the NodeManager surfaces.

export function bytesPretty(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  let decimals = 0;
  if (n < 10) decimals = 2;
  else if (n < 100) decimals = 1;
  return `${n.toFixed(decimals)} ${units[i]}`;
}

/** "just now" / "4m ago" / "3h ago" / "2d ago" — activity-feed style. */
export function relativeTime(tsMs: number, nowMs = Date.now()): string {
  const d = Math.max(0, nowMs - tsMs);
  if (d < 45_000) return 'just now';
  if (d < 90_000) return '1m ago';
  const mins = Math.round(d / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(d / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(d / 86_400_000);
  return `${days}d ago`;
}

/** "+$260.61/mo" / "−$130.31/mo" / "$0.00/mo" for cost-delta chips. */
export function usdDeltaPretty(delta: number): string {
  let sign = '';
  if (delta > 0) sign = '+';
  else if (delta < 0) sign = '−';
  return `${sign}$${Math.abs(delta).toFixed(2)}/mo`;
}
