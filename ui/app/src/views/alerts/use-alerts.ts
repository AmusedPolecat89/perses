// Copyright OBSESC Authors
//
// Alerts data layer (Lane U1). Fetches GET /obsesc-api/v1/alerts directly
// (module-federation boundary: app views cannot import the datasource
// plugin's client.ts — same direct-fetch pattern as ObsescExploreView /
// use-capabilities).
//
// The types below MIRROR the frozen wire contract in
// ui/plugins/datasource-obsesc/src/model/client.ts (ObsescAlertStatus /
// ObsescAlert / ObsescAlertsResponse). KEEP IN SYNC WITH client.ts —
// a drift here is a bug against the frozen contract, not a local choice.

import { useQuery, UseQueryResult } from '@tanstack/react-query';
import { useCapabilities } from '../../hooks/use-capabilities';

// --- wire types (keep in sync with client.ts, frozen by Lane U0) -----------

export type AlertStatus = 'pending' | 'firing' | 'resolved';

/** Server-side status filter; 'all' returns every persisted alert state. */
export type AlertStatusFilter = AlertStatus | 'all';

export interface ObsescAlert {
  rule: string;
  /** 'novelty' | 'behavioral' | 'predictive' (open set on the wire). */
  predicate: string;
  series: string;
  service: string;
  status: AlertStatus;
  consecutive_windows: number;
  window_start_ns: number;
  window_end_ns: number;
  fired_window_start_ns?: number;
  resolved_window_start_ns?: number;
  summary: string;
}

export interface ObsescAlertsResponse {
  alerts: ObsescAlert[];
  /** Matching alerts before `limit` truncation. */
  total: number;
}

// --- fetch ------------------------------------------------------------------

const ALERTS_URL = '/obsesc-api/v1/alerts';
const FETCH_TIMEOUT_MS = 30_000;
/** Server default 100, hard cap 1000 (above the cap → 400). Never offer more. */
export const ALERTS_LIMIT_MAX = 1000;
/** Wedge rule: no polling faster than 15s. */
const REFETCH_INTERVAL_MS = 15_000;
/** The nav badge / node chip poll more gently still. */
const FIRING_COUNT_STALE_MS = 30_000;

/**
 * `AbortSignal.any([...])` without `AbortSignal.any` — the app's TS lib
 * target predates it (same helper as use-capabilities). Aborts when EITHER
 * react-query's signal (unmount/invalidation) or the timeout aborts.
 */
function eitherSignal(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort();
  if (a.aborted || b.aborted) ctl.abort();
  else {
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return ctl.signal;
}

async function fetchAlerts(
  params: { limit: number; status: AlertStatusFilter },
  signal?: AbortSignal
): Promise<ObsescAlertsResponse> {
  const qs = new URLSearchParams();
  qs.set('limit', String(Math.min(params.limit, ALERTS_LIMIT_MAX)));
  qs.set('status', params.status);
  const r = await fetch(`${ALERTS_URL}?${qs.toString()}`, {
    signal: eitherSignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)),
  });
  if (!r.ok) {
    throw new Error(`GET /v1/alerts failed: HTTP ${r.status}`);
  }
  return (await r.json()) as ObsescAlertsResponse;
}

// --- hooks -------------------------------------------------------------------

/**
 * The alerts table query. `enabled` is threaded from the view's capability
 * gate so a disabled/unreachable node never gets polled.
 */
export function useAlerts(
  status: AlertStatusFilter,
  limit: number,
  enabled: boolean
): UseQueryResult<ObsescAlertsResponse> {
  return useQuery<ObsescAlertsResponse>({
    queryKey: ['obsesc-alerts', status, limit],
    enabled,
    refetchInterval: REFETCH_INTERVAL_MS,
    queryFn: ({ signal }) => fetchAlerts({ limit, status }, signal),
  });
}

/**
 * Firing-alert count for the Header nav badge and the NodeCard chip — one
 * shared query key, so both surfaces ride a single poll. `limit=1` keeps
 * the payload tiny: `total` is the match count BEFORE truncation, which is
 * exactly the number we want.
 *
 * Returns `null` when the count must not be shown: alerting disabled,
 * capabilities unavailable, still loading, or the count fetch has no
 * answer yet.
 */
export function useFiringAlertCount(): number | null {
  const caps = useCapabilities();
  const enabled = !caps.isLoading && !caps.unavailable && caps.alerting;
  const query = useQuery<number>({
    queryKey: ['obsesc-alerts', 'firing-count'],
    enabled,
    staleTime: FIRING_COUNT_STALE_MS,
    refetchInterval: FIRING_COUNT_STALE_MS,
    queryFn: async ({ signal }) =>
      (await fetchAlerts({ limit: 1, status: 'firing' }, signal)).total,
  });
  if (!enabled || query.data === undefined) return null;
  return query.data;
}
