// Copyright OBSESC Authors
//
// The shared time-range store (U11) — one range for Explore, the needle,
// Investigate and the dashboards.
//
// It is a module-level store rather than a React context on purpose:
//
//   1. The custom views must stay renderable standalone under jest (the
//      Explore suite mounts `<ObsescExploreView/>` with nothing but a
//      ThemeProvider around it), so the range must not require a provider
//      or a Router above it.
//   2. Perses' own time context is created INSIDE `ViewDashboard`, per
//      dashboard. There is no app-level instance of it to hang off, and
//      wrapping one around the app would not be the one the dashboards use.
//
// The bridge to the dashboards is therefore the encoding they already
// publish — the `start`/`end` query params — mirrored in both directions by
// `components/TimeRangeUrlSync.tsx` (URL → store) and seeded into a
// dashboard's URL before it mounts by `useSeedDashboardTimeParams`.
//
// `pinned` distinguishes "nobody has chosen a range this session" from "the
// user chose one". A cold visit to a dashboard must keep the range its
// author wrote into the dashboard spec; only an explicit choice travels.

import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_RANGE, TimeRange, decodeRange, encodeRange, rangesEqual } from '../model/time-range';

const STORAGE_KEY = 'obsesc.time-range';

interface StoreState {
  /** `null` = nobody has chosen; the default applies and nothing propagates. */
  range: TimeRange | null;
}

let state: StoreState = { range: null };
const listeners = new Set<() => void>();
let hydrated = false;

/** Session-scoped, not local: a range is investigation state, not a setting. */
function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Storage can throw outright under a strict cookie policy.
    return null;
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const raw = session()?.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { start?: unknown; end?: unknown };
    const decoded = decodeRange(
      typeof parsed.start === 'string' ? parsed.start : null,
      typeof parsed.end === 'string' ? parsed.end : null
    );
    if (decoded !== null) state = { range: decoded };
  } catch {
    // A corrupt entry means "no stored range", never a crash on boot.
  }
}

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  hydrate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): StoreState {
  hydrate();
  return state;
}

/**
 * Set the shared range. A no-op when the range is unchanged — every writer
 * here is an effect somewhere, and re-emitting an identical range would make
 * the URL mirror and the views chase each other.
 */
export function setSharedTimeRange(range: TimeRange): void {
  hydrate();
  if (rangesEqual(state.range, range)) return;
  state = { range };
  try {
    session()?.setItem(STORAGE_KEY, JSON.stringify(encodeRange(range)));
  } catch {
    // Full/blocked storage loses persistence across a reload, not the range.
  }
  emit();
}

/** Read outside React (the URL mirror needs this before it subscribes). */
export function readSharedTimeRange(): TimeRange | null {
  hydrate();
  return state.range;
}

/** Test seam: drop the store back to "nobody has chosen". */
export function resetSharedTimeRange(): void {
  hydrated = true;
  state = { range: null };
  try {
    session()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
  emit();
}

export interface SharedTimeRange {
  /** The range to use — the default when nobody has chosen. */
  range: TimeRange;
  /** False while the default is standing in. */
  pinned: boolean;
  setRange: (range: TimeRange) => void;
}

export function useSharedTimeRange(): SharedTimeRange {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setRange = useCallback((range: TimeRange) => setSharedTimeRange(range), []);
  return {
    range: snapshot.range ?? DEFAULT_RANGE,
    pinned: snapshot.range !== null,
    setRange,
  };
}
