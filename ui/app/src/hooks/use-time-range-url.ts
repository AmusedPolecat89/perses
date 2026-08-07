// Copyright OBSESC Authors
//
// The bridge between the shared time-range store and the Perses time
// context (U11).
//
// Perses does not expose its dashboard time context above `ViewDashboard`,
// but it does publish it: `TimeRangeProviderWithQueryParams` reads and writes
// the `start` / `end` query params, and `useInitialTimeRange` recomputes the
// dashboard's range from those params on every change. So the params ARE the
// shared surface, and this module is the only place that knows it:
//
//   mirror  — every route: params → store (a dashboard picker change lands
//             in the store) and store → params (a range chosen in Explore or
//             Investigate is written back onto the URL, so it is shareable
//             and so it survives into whatever route comes next).
//
//   seed    — dashboard routes only: a dashboard must be MOUNTED with the
//             params already in place, because `useInitialTimeRange` runs
//             during ViewDashboard's first render. An effect that fixes the
//             URL afterwards loses the race with Perses' own writer, which
//             fills a missing `start` with the dashboard's authored default.
//             `useSeedDashboardTimeParams` therefore reports "not ready" and
//             the caller withholds the dashboard for one tick.
//
// Both directions are guarded on the ENCODED range, so a value that round
// trips through either writer converges instead of ping-ponging.

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { decodeRange, encodeRange, rangesEqual } from '../model/time-range';
import { readSharedTimeRange, setSharedTimeRange, useSharedTimeRange } from './use-shared-time-range';

/**
 * Keep the URL and the shared store in agreement. Call once, high in the
 * tree (App). Returns nothing: everything it does is a side effect on the
 * two things it mirrors.
 */
export function useTimeRangeUrlMirror(): void {
  const [params, setParams] = useSearchParams();
  const { range, pinned } = useSharedTimeRange();

  const urlStart = params.get('start');
  const urlEnd = params.get('end');

  // URL → store. An absent/undecodable param is NOT "clear the range": a
  // nav link simply drops the query string, and dropping the investigation's
  // window every time the operator changes section is the exact friction
  // U11 is about.
  useEffect(() => {
    const fromUrl = decodeRange(urlStart, urlEnd);
    if (fromUrl !== null) setSharedTimeRange(fromUrl);
  }, [urlStart, urlEnd]);

  // store → URL, once a range has actually been chosen.
  useEffect(() => {
    if (!pinned) return;
    if (rangesEqual(decodeRange(urlStart, urlEnd), range)) return;
    const encoded = encodeRange(range);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('start', encoded.start);
        if (encoded.end === undefined) next.delete('end');
        else next.set('end', encoded.end);
        return next;
      },
      // Replace: the time range is a view of the page, not a page in the
      // history. Pushing would make Back walk through every picker change.
      { replace: true }
    );
  }, [pinned, range, urlStart, urlEnd, setParams]);
}

/**
 * Put the shared range into the URL BEFORE a dashboard mounts.
 *
 * Returns `false` while the params still need writing — the caller must not
 * render the dashboard until it returns `true`, or `useInitialTimeRange`
 * will have already captured the dashboard's own default and the shared
 * range will appear to have been ignored.
 *
 * A cold session (nothing pinned) returns `true` immediately: a dashboard's
 * authored duration stands until somebody actually picks a range.
 */
export function useSeedDashboardTimeParams(): boolean {
  const [params, setParams] = useSearchParams();
  const stored = readSharedTimeRange();
  const needsSeed = stored !== null && params.get('start') === null;

  useEffect(() => {
    if (!needsSeed || stored === null) return;
    const encoded = encodeRange(stored);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('start', encoded.start);
        if (encoded.end === undefined) next.delete('end');
        else next.set('end', encoded.end);
        return next;
      },
      { replace: true }
    );
    // `stored` is read outside React state; the boolean is what actually
    // drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsSeed, setParams]);

  return !needsSeed;
}
