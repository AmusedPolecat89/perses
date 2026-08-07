// Copyright OBSESC Authors
//
// The ONE time range (U11).
//
// Before this module the product had four unrelated time models: Explore's
// SQL box carried raw epoch-nanosecond literals, the needle section had a
// private Range dropdown, dashboards used the Perses picker, and Investigate
// had two datetime-local pairs. Nothing shared state, so moving one
// investigation across surfaces meant re-entering the same window by hand
// three times.
//
// WHO OWNS THE RANGE: the Perses time context, exactly as it already
// serialises itself — the `start` / `end` query params
// (@perses-dev/plugin-system runtime/TimeRangeProvider/query-params.ts):
//
//   relative → start=<DurationString>, end absent   e.g. `?start=1h`
//   absolute → start=<epoch ms>&end=<epoch ms>      e.g. `?start=1754500000000&end=…`
//
// This module is that encoding, re-implemented rather than imported: every
// custom OBSESC view is testable standalone under jest, and the jest module
// map cannot resolve `@perses-dev/spec` (the package that actually defines
// DURATION_REGEX) in this fork. The regex below is transcribed from
// `@perses-dev/spec` common/duration.ts and a unit test pins it — if the
// upstream encoding ever moves, dashboards and the custom views must move
// together or the shared range silently stops being shared.
//
// Nothing here reads the clock at module scope: a relative range is a
// DESCRIPTION, and it is resolved against `Date.now()` at the moment a query
// is submitted. That is what makes "Last 1 hour" mean the same thing on a
// dashboard, in Explore and in Investigate.

/** A Perses `DurationString`: `1h`, `15m`, `1h30m`, `7d`. */
export type DurationString = string;

export interface RelativeRange {
  kind: 'relative';
  duration: DurationString;
}

export interface AbsoluteRange {
  kind: 'absolute';
  /** Epoch ms, inclusive. */
  startMs: number;
  /** Epoch ms, exclusive. */
  endMs: number;
}

export type TimeRange = RelativeRange | AbsoluteRange;

/** A range resolved against a concrete clock reading. */
export interface ResolvedRange {
  fromMs: number;
  toMs: number;
  fromNs: number;
  toNs: number;
}

export const NS_PER_MS = 1e6;

/**
 * Transcribed from `@perses-dev/spec` `DURATION_REGEX`. Note it matches the
 * EMPTY string (every group is optional), which is why `parseDuration`
 * rejects empties explicitly rather than leaning on the regex.
 */
export const DURATION_REGEX = /^(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/;

const MS = 1;
const SECOND = 1000 * MS;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Calendar-free year, as a duration string is a duration and not a date. */
const YEAR = 365 * DAY;

/**
 * `1h30m` → 5_400_000. `null` for anything that is not a duration string —
 * including `''`, which the upstream regex accepts and we must not.
 */
export function parseDuration(s: string): number | null {
  if (s === '') return null;
  const m = DURATION_REGEX.exec(s);
  if (m === null) return null;
  const n = (g: string | undefined): number => (g === undefined ? 0 : Number(g));
  return (
    n(m[1]) * YEAR +
    n(m[2]) * WEEK +
    n(m[3]) * DAY +
    n(m[4]) * HOUR +
    n(m[5]) * MINUTE +
    n(m[6]) * SECOND +
    n(m[7]) * MS
  );
}

export function isDurationString(s: string): boolean {
  return parseDuration(s) !== null;
}

/** The default when nobody has chosen anything yet. */
export const DEFAULT_RANGE: RelativeRange = { kind: 'relative', duration: '1h' };

/** The preset ladder every OBSESC time control offers. */
export const RANGE_PRESETS: Array<{ duration: DurationString; label: string }> = [
  { duration: '15m', label: 'Last 15 minutes' },
  { duration: '1h', label: 'Last hour' },
  { duration: '6h', label: 'Last 6 hours' },
  { duration: '24h', label: 'Last 24 hours' },
  { duration: '7d', label: 'Last 7 days' },
  { duration: '30d', label: 'Last 30 days' },
];

/**
 * Resolve against a clock reading. `nowMs` is a parameter, never an implicit
 * `Date.now()`, so a caller that must pin one instant across several queries
 * (Investigate's two windows, Explore's SQL rewrite) can.
 */
export function resolveRange(range: TimeRange, nowMs: number): ResolvedRange {
  if (range.kind === 'absolute') {
    return {
      fromMs: range.startMs,
      toMs: range.endMs,
      fromNs: Math.floor(range.startMs * NS_PER_MS),
      toNs: Math.floor(range.endMs * NS_PER_MS),
    };
  }
  const span = parseDuration(range.duration) ?? (parseDuration(DEFAULT_RANGE.duration) as number);
  const fromMs = nowMs - span;
  return {
    fromMs,
    toMs: nowMs,
    fromNs: Math.floor(fromMs * NS_PER_MS),
    toNs: Math.floor(nowMs * NS_PER_MS),
  };
}

/** Human label for the control and for the "what am I looking at" captions. */
export function rangeLabel(range: TimeRange): string {
  if (range.kind === 'relative') {
    const preset = RANGE_PRESETS.find((p) => p.duration === range.duration);
    return preset?.label ?? `Last ${range.duration}`;
  }
  return `${isoSeconds(range.startMs)} → ${isoSeconds(range.endMs)} UTC`;
}

/** `2026-08-07 10:04:11` — the same shape every OBSESC surface prints. */
export function isoSeconds(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

// ─── the Perses `start`/`end` param encoding ───────────────────────────

export interface TimeRangeParams {
  start: string;
  /** Absent for a relative range — Perses deletes `end` in that case. */
  end?: string;
}

/**
 * Encode for the URL. Absolute instants are floored to whole SECONDS because
 * that is what Perses does (`getUnixTime(date) * 1000`); emitting more
 * precision would make our encoding and theirs disagree on a round trip and
 * leave the two writers fighting over the same param.
 */
export function encodeRange(range: TimeRange): TimeRangeParams {
  if (range.kind === 'relative') return { start: range.duration };
  return {
    start: String(Math.floor(range.startMs / 1000) * 1000),
    end: String(Math.floor(range.endMs / 1000) * 1000),
  };
}

/** `null` when the params carry no usable range (the common case). */
export function decodeRange(start: string | null, end: string | null): TimeRange | null {
  if (start === null || start === '') return null;
  if (isDurationString(start)) return { kind: 'relative', duration: start };
  const startMs = Number(start);
  const endMs = Number(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || end === null || end === '') return null;
  if (endMs <= startMs) return null;
  return { kind: 'absolute', startMs, endMs };
}

/** Stable identity for effect keys and for URL-sync ping-pong guards. */
export function rangeKey(range: TimeRange): string {
  const p = encodeRange(range);
  return p.end === undefined ? p.start : `${p.start}..${p.end}`;
}

export function rangesEqual(a: TimeRange | null, b: TimeRange | null): boolean {
  if (a === null || b === null) return a === b;
  return rangeKey(a) === rangeKey(b);
}

// ─── datetime-local <input> bridge ─────────────────────────────────────

/** Epoch ms → the `datetime-local` value in the BROWSER's zone. */
export function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** `null` when the field is empty or half-typed. */
export function localInputToMs(v: string): number | null {
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}
