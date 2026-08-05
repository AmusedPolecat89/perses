// Copyright OBSESC Authors
//
// useCapabilities(): the ONE primitive every view/panel gates itself with
// (Lane U0). Fetches GET /obsesc-api/v1/capabilities (direct-fetch pattern,
// same as use-node-stats / Explore) and caches it via react-query.
//
// Tri-state contract (PR standard #4): a view must be able to distinguish
//   - loading        → `isLoading: true`
//   - not enabled    → capability false, `unavailable: false`
//   - node unreachable / errored (503, network, timeout)
//                    → ALL capabilities false, `unavailable: true`
// so "this node doesn't have crosstabs configured" never renders the same
// as "the node is down".

import { useQuery } from '@tanstack/react-query';

export interface CapabilityCrosstabPair {
  /** Row axis: 'template' or a dimension name. */
  row: string;
  /** Column axis: a dimension name. */
  col: string;
}

/**
 * The six shipper-facing ingest ports, as the node's config declares them
 * (keys mirror the wire's `ingest_ports` object — the `_port` suffix is
 * dropped since the wrapping key already says it).
 */
export interface IngestPorts {
  otlp_http: number;
  otlp_grpc: number;
  vector: number;
  es_bulk: number;
  hec: number;
  fluent: number;
}

/**
 * Compiled fallback when the node's real ports are unknown (unreachable,
 * gated, or malformed response) — mirrors the obsesc-config IngestConfig
 * defaults. If a Rust default changes, this table must change with it
 * (pinned by the unit test).
 */
export const DEFAULT_INGEST_PORTS: IngestPorts = {
  otlp_http: 4318,
  otlp_grpc: 4317,
  vector: 9000,
  es_bulk: 9200,
  hec: 8088,
  fluent: 24224,
};

/** Wire shape of GET /v1/capabilities — every field always present. */
export interface ObsescCapabilities {
  preview: boolean;
  /** Raw SQL engine (micro-Athena) wired. */
  sql: boolean;
  crosstab: { enabled: boolean; pairs: CapabilityCrosstabPair[] };
  /** Fingerprint similarity epochs mintable (artifact + manifest stores). */
  similar: boolean;
  forecast: boolean;
  custody: boolean;
  alerting: boolean;
  compaction: boolean;
  cluster: {
    enabled: boolean;
    routing: 'owner' | 'arrival';
    /**
     * True when the node can launch/terminate EC2 instances (control-plane
     * provisioning wired: IAM role + launch template). Gates Add-node and
     * the terminate option; drain/remove of existing members works without it.
     */
    provision: boolean;
  };
  /**
   * The node's config-declared shipper ports, or null when unknown
   * (unreachable node, older node without the field, malformed values) —
   * consumers fall back to DEFAULT_INGEST_PORTS and say so.
   */
  ingest_ports: IngestPorts | null;
}

export interface CapabilitiesState extends ObsescCapabilities {
  /**
   * True when the capabilities endpoint could not be reached or errored —
   * the all-false capability flags then mean "unknown", not "disabled".
   */
  unavailable: boolean;
}

export interface UseCapabilitiesResult extends CapabilitiesState {
  /** First answer still in flight (capabilities are all-false meanwhile). */
  isLoading: boolean;
}

/** The all-disabled shape returned on any failure. */
export const DISABLED_CAPABILITIES: CapabilitiesState = {
  preview: false,
  sql: false,
  crosstab: { enabled: false, pairs: [] },
  similar: false,
  forecast: false,
  custody: false,
  alerting: false,
  compaction: false,
  cluster: { enabled: false, routing: 'owner', provision: false },
  ingest_ports: null,
  unavailable: true,
};

const CAPABILITIES_URL = '/obsesc-api/v1/capabilities';
const FETCH_TIMEOUT_MS = 10_000;
/** Capabilities are config-static per process: cache aggressively. */
const STALE_TIME_MS = 5 * 60_000;

/**
 * `AbortSignal.any([...])` without `AbortSignal.any` — the app's TS lib
 * target predates it. Aborts when EITHER input aborts (react-query's
 * unmount/invalidation signal, or the timeout).
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

/**
 * Coerce a parsed response body into the capability shape. A shape miss
 * (proxy error page, wrong service on the port, JSON error body) is a
 * FAILURE — it throws so react-query treats it exactly like a network
 * error (retry, error-state, no fresh-for-staleTime caching) and the
 * hook maps it to all-disabled + `unavailable: true`. It must never
 * masquerade as a valid "everything disabled" answer (review fix #1).
 * Exported for unit tests.
 */
export function toCapabilitiesState(body: unknown): CapabilitiesState {
  // `preview` is always true on a real response, so its presence as a
  // boolean is the cheapest honest shape sentinel.
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).preview !== 'boolean'
  ) {
    throw new Error('malformed capabilities response (wrong service on the port?)');
  }
  const b = body as Record<string, unknown>;
  const bool = (v: unknown): boolean => v === true;
  // A real node serializes u16s; anything else is proxy/wrong-service junk.
  const port = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
  // All-or-nothing: one bad field nulls the whole object (mixing real node
  // ports with compiled defaults would be worse than honest defaults). Like
  // the pairs filtering — and unlike the shape sentinel — this must NOT
  // throw: a missing/odd ingest_ports can't nuke every other capability.
  const parseIngestPorts = (v: unknown): IngestPorts | null => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const p = v as Record<string, unknown>;
    const keys = ['otlp_http', 'otlp_grpc', 'vector', 'es_bulk', 'hec', 'fluent'] as const;
    if (!keys.every((k) => port(p[k]))) return null;
    return {
      otlp_http: p.otlp_http as number,
      otlp_grpc: p.otlp_grpc as number,
      vector: p.vector as number,
      es_bulk: p.es_bulk as number,
      hec: p.hec as number,
      fluent: p.fluent as number,
    };
  };
  const crosstab = (typeof b.crosstab === 'object' && b.crosstab !== null ? b.crosstab : {}) as Record<string, unknown>;
  const cluster = (typeof b.cluster === 'object' && b.cluster !== null ? b.cluster : {}) as Record<string, unknown>;
  const pairs: CapabilityCrosstabPair[] = Array.isArray(crosstab.pairs)
    ? crosstab.pairs.filter(
        (p): p is CapabilityCrosstabPair =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as CapabilityCrosstabPair).row === 'string' &&
          typeof (p as CapabilityCrosstabPair).col === 'string'
      )
    : [];
  return {
    preview: bool(b.preview),
    sql: bool(b.sql),
    crosstab: { enabled: bool(crosstab.enabled), pairs },
    similar: bool(b.similar),
    forecast: bool(b.forecast),
    custody: bool(b.custody),
    alerting: bool(b.alerting),
    compaction: bool(b.compaction),
    cluster: {
      enabled: bool(cluster.enabled),
      routing: cluster.routing === 'arrival' ? 'arrival' : 'owner',
      // Absent on pre-control-plane nodes → false (actions stay gated).
      provision: bool(cluster.provision),
    },
    ingest_ports: parseIngestPorts(b.ingest_ports),
    unavailable: false,
  };
}

export function useCapabilities(): UseCapabilitiesResult {
  const query = useQuery<CapabilitiesState>({
    queryKey: ['obsesc-capabilities'],
    staleTime: STALE_TIME_MS,
    retry: 1,
    queryFn: async ({ signal }) => {
      // Wedge rule: the fetch always times out, and react-query's own
      // signal (unmount/invalidations) is threaded alongside it.
      const r = await fetch(CAPABILITIES_URL, {
        signal: eitherSignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)),
      });
      if (!r.ok) {
        // 503 / 401 / proxy errors: a product state, not an exception —
        // but throw so react-query retries and re-probes on remount,
        // while the hook's return path maps it to DISABLED below.
        throw new Error(`capabilities fetch failed: HTTP ${r.status}`);
      }
      return toCapabilitiesState(await r.json());
    },
  });
  if (query.data) {
    return { ...query.data, isLoading: false };
  }
  return {
    ...DISABLED_CAPABILITIES,
    // While the first probe is in flight, the all-false flags mean
    // "unknown, still asking" — not yet "unreachable".
    unavailable: query.isError,
    isLoading: query.isLoading,
  };
}
