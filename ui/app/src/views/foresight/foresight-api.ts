// Copyright OBSESC Authors
//
// Foresight (Lane U5) — local wire types + fetch helpers for the
// world-model endpoints (POST /v1/forecast, POST /v1/whatif).
//
// App views use the direct-fetch pattern (same as ObsescExploreView /
// use-node-stats): they CANNOT import the plugin client. These types
// mirror `ui/plugins/datasource-obsesc/src/model/client.ts` — KEEP IN
// SYNC with the frozen client (the wire contract):
//   - template keys are DECIMAL STRINGS (u64 > 2^53; JSON numbers would
//     corrupt them);
//   - `pattern` is `string | null` (null → render the key, labelled
//     "unknown template");
//   - `warning` is optional-omitted;
//   - `approximation` ("arrival-order, no trace correlation") is on
//     every response and must ALWAYS be visible in the UI.

import { eitherSignal } from '../../utils/either-signal';

const API = '/obsesc-api';
/** The deadline the progress status line quotes for both ops. */
export const FETCH_TIMEOUT_MS = 60_000;

// Server bounds (crates/query/obsesc-query/src/worldmodel.rs) — mirrored
// client-side so the UI never submits a request the server will 400.
/** History range cap: 7 days (MAX_HISTORY_RANGE_NS = 7 * 86_400e9). */
export const MAX_HISTORY_RANGE_SECONDS = 7 * 86_400;
/** What-if propagation depth bound (1..=16 → 400 outside). */
export const MAX_WHATIF_STEPS = 16;
/** Default result cap (server default 20, cap 100). */
export const DEFAULT_TOP = 20;

export interface ObsescStateWeight {
  /** Template key as a decimal string. */
  key: string;
  weight: number;
}

export interface ObsescForecastRequest {
  service: string;
  from_ns: number;
  to_ns: number;
  /** Omitted → derived from the newest in-range window's template counts. */
  state?: ObsescStateWeight[];
  top?: number;
}

export interface ObsescWhatIfRequest {
  service: string;
  from_ns: number;
  to_ns: number;
  state?: ObsescStateWeight[];
  /** Propagation depth (1..=16 → 400 outside). */
  steps: number;
  top?: number;
}

export interface ObsescPrediction {
  /** Template key as a decimal string. */
  key: string;
  pattern: string | null;
  probability: number;
  support: number;
  low_support: boolean;
}

export interface ObsescWhatIfHit {
  key: string;
  pattern: string;
  probability: number;
  steps: number;
  /** Template keys along the path, decimal strings. */
  path: string[];
  path_patterns: Array<string | null>;
  min_edge_support: number;
  low_support: boolean;
}

/** Honest-uncertainty block on both world-model responses. */
export interface ObsescGatherEvidence {
  nodes: number;
  windows_with_transitions: number;
  scanned_files: number;
  total_transitions: number;
  /** Transition mass folded by the top-M bound (visible truncation). */
  overflow_mass: number;
  /** The support floor `low_support` flags are measured against. */
  low_support_floor: number;
}

export interface ObsescForecastResponse {
  service: string;
  from_ns: number;
  to_ns: number;
  state_source: 'provided' | 'derived';
  predictions: ObsescPrediction[];
  /** Always present — render verbatim, never a tooltip. */
  approximation: string;
  evidence: ObsescGatherEvidence;
  /** True when EVERY prediction is low-support (or there are none). */
  low_support: boolean;
  warning?: string;
}

export interface ObsescWhatIfResponse {
  service: string;
  from_ns: number;
  to_ns: number;
  state_source: 'provided' | 'derived';
  steps: number;
  hits: ObsescWhatIfHit[];
  approximation: string;
  evidence: ObsescGatherEvidence;
  low_support: boolean;
  warning?: string;
}

/** Wedge rule: every fetch times out AND aborts with the caller's signal. */
async function post<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: eitherSignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)),
  });
  if (!r.ok) {
    throw new Error(`OBSESC ${path} ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as T;
}

export async function fetchForecast(req: ObsescForecastRequest, signal: AbortSignal): Promise<ObsescForecastResponse> {
  return post<ObsescForecastResponse>('/v1/forecast', req, signal);
}

export async function fetchWhatIf(req: ObsescWhatIfRequest, signal: AbortSignal): Promise<ObsescWhatIfResponse> {
  return post<ObsescWhatIfResponse>('/v1/whatif', req, signal);
}
