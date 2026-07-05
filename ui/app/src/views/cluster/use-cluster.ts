// Copyright OBSESC Authors
//
// Cluster control-plane data layer (Phase 4, NodeManager-goes-live).
// Direct-fetch + react-query, same pattern as use-alerts / use-capabilities.
//
// The types below MIRROR the wire contract of the backend branch
// feat/cluster-control-plane verbatim:
//   GET    /v1/cluster                       → ClusterView (per-node role+status)
//   POST   /v1/cluster/nodes                 → 202 launch accepted
//   POST   /v1/cluster/nodes/{id}/drain      → drain started (409 last active)
//   GET    /v1/cluster/nodes/{id}/drain      → drain progress
//   DELETE /v1/cluster/nodes/{id}?terminate=&force= → removal (409 not drained)
//   POST   /v1/cluster/cost-preview          → honest before/after monthly USD
//   GET    /v1/cluster/activity?limit=50     → newest-first operator audit feed

import { useMutation, UseMutationResult, useQuery, useQueryClient, UseQueryResult } from '@tanstack/react-query';

const API = '/obsesc-api';
const FETCH_TIMEOUT_MS = 30_000;

export const CLUSTER_QUERY_KEY = ['obsesc-cluster-view'] as const;
export const ACTIVITY_QUERY_KEY = ['obsesc-cluster-activity'] as const;

// --- wire types (keep in sync with feat/cluster-control-plane) --------------

export type ClusterNodeStatus = 'active' | 'draining' | 'down';

export interface ClusterNode {
  id: string;
  addr: string;
  /** 'ingest' | 'query' | 'all' (open set on the wire). */
  role: string;
  status: ClusterNodeStatus;
}

export interface ClusterView {
  enabled: boolean;
  epoch: number;
  this_node: string | null;
  routing: 'owner' | 'arrival';
  nodes: ClusterNode[];
}

export type DrainPhase = 'active' | 'draining' | 'drained' | 'down';

export interface DrainStatus {
  id: string;
  status: DrainPhase;
  /** Summary buckets still open on the draining node. */
  open_buckets: number;
  /** WAL bytes not yet flushed/handed off. Converges to 0 as drain completes. */
  wal_backlog_bytes: number;
}

export interface CostPreview {
  currency: string;
  current_monthly_usd: number;
  projected_monthly_usd: number;
  delta_monthly_usd: number;
  nodes_before: number;
  nodes_after: number;
  /** Server-side pricing caveats — surfaced verbatim so costs stay honest. */
  assumptions: string[];
}

export interface LaunchAccepted {
  instance_id: string;
  state: 'launching';
}

export interface RemoveResult {
  epoch: number;
  removed: string;
  terminated: boolean;
}

export type ActivityAction = 'launch' | 'drain' | 'remove_node' | 'terminate';

export interface ActivityEvent {
  ts_ms: number;
  actor: string;
  action: ActivityAction;
  node_id: string;
  detail: string;
  cost_delta_monthly_usd?: number;
}

// --- errors ------------------------------------------------------------------

/**
 * A 409 from the control plane is a DESIGNED product state (last active
 * node, not drained yet, provisioning disabled), never a toast-worthy
 * exception. Dialogs branch on this class to render the designed copy.
 */
export class ClusterConflictError extends Error {}

/** 422 from cost-preview: unknown instance type. */
export class UnknownInstanceTypeError extends Error {}

// --- fetch plumbing ----------------------------------------------------------

/**
 * `AbortSignal.any([...])` without `AbortSignal.any` — the app's TS lib
 * target predates it (same helper as use-capabilities / use-alerts).
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

async function apiFetch(path: string, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    signal: eitherSignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)),
  });
}

async function throwForStatus(r: Response, what: string): Promise<Response> {
  if (r.status === 409) throw new ClusterConflictError(await r.text());
  if (r.status === 422) throw new UnknownInstanceTypeError(await r.text());
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${await r.text()}`);
  return r;
}

// --- membership --------------------------------------------------------------

/** Coerce a wire node defensively — pre-Phase-4 nodes omit role/status. */
function toClusterNode(n: unknown): ClusterNode {
  const o = (typeof n === 'object' && n !== null ? n : {}) as Record<string, unknown>;
  const status: ClusterNodeStatus = o.status === 'draining' || o.status === 'down' ? o.status : 'active';
  return {
    id: typeof o.id === 'string' ? o.id : '',
    addr: typeof o.addr === 'string' ? o.addr : '',
    role: typeof o.role === 'string' && o.role !== '' ? o.role : 'all',
    status,
  };
}

/**
 * Live membership. `null` = endpoint absent (older node) → the view falls
 * back to the single local card. Pass a faster interval while a launch is
 * pending so the self-join shows up promptly.
 */
export function useClusterView(refetchIntervalMs = 10_000): UseQueryResult<ClusterView | null> {
  return useQuery<ClusterView | null>({
    queryKey: CLUSTER_QUERY_KEY,
    refetchInterval: refetchIntervalMs,
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await apiFetch('/v1/cluster', undefined, signal);
      if (!res.ok) return null; // older node / endpoint absent → fallback
      const body = (await res.json()) as Record<string, unknown>;
      return {
        enabled: body.enabled === true,
        epoch: typeof body.epoch === 'number' ? body.epoch : 0,
        this_node: typeof body.this_node === 'string' ? body.this_node : null,
        routing: body.routing === 'arrival' ? 'arrival' : 'owner',
        nodes: Array.isArray(body.nodes) ? body.nodes.map(toClusterNode) : [],
      };
    },
  });
}

// --- cost preview -------------------------------------------------------------

export interface CostPreviewRequest {
  action: 'add' | 'remove';
  instance_type?: string;
  node_id?: string;
}

/**
 * Honest pre-commit cost preview. Enabled only while the confirm surface
 * is open; keyed on the exact request so switching instance types refetches.
 */
export function useCostPreview(req: CostPreviewRequest, enabled: boolean): UseQueryResult<CostPreview> {
  return useQuery<CostPreview>({
    queryKey: ['obsesc-cluster-cost-preview', req.action, req.instance_type ?? '', req.node_id ?? ''],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const r = await apiFetch(
        '/v1/cluster/cost-preview',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        },
        signal
      );
      await throwForStatus(r, 'POST /v1/cluster/cost-preview');
      return (await r.json()) as CostPreview;
    },
  });
}

// --- mutations ----------------------------------------------------------------

/** Refresh everything the control plane just changed. */
function useInvalidateCluster(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: CLUSTER_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY });
  };
}

export function useAddNode(): UseMutationResult<LaunchAccepted, Error, { instance_type: string; role: string }> {
  const invalidate = useInvalidateCluster();
  return useMutation({
    mutationFn: async (body) => {
      const r = await apiFetch('/v1/cluster/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await throwForStatus(r, 'POST /v1/cluster/nodes');
      return (await r.json()) as LaunchAccepted;
    },
    onSuccess: invalidate,
  });
}

export function useStartDrain(): UseMutationResult<
  { epoch: number; id: string; status: 'draining' },
  Error,
  { nodeId: string }
> {
  const invalidate = useInvalidateCluster();
  return useMutation({
    mutationFn: async ({ nodeId }) => {
      const r = await apiFetch(`/v1/cluster/nodes/${encodeURIComponent(nodeId)}/drain`, {
        method: 'POST',
      });
      await throwForStatus(r, 'POST /v1/cluster/nodes/{id}/drain');
      return (await r.json()) as { epoch: number; id: string; status: 'draining' };
    },
    onSuccess: invalidate,
  });
}

/**
 * Drain progress poll — real numbers (open buckets, WAL backlog), no fake
 * spinners. Polls fast while enabled; callers enable it exactly while a
 * drain is visible (dialog open / row in `draining` state).
 */
export function useDrainStatus(nodeId: string, enabled: boolean): UseQueryResult<DrainStatus> {
  return useQuery<DrainStatus>({
    queryKey: ['obsesc-cluster-drain', nodeId],
    enabled,
    refetchInterval: (data) => (data?.status === 'draining' ? 2_000 : false),
    retry: false,
    queryFn: async ({ signal }) => {
      const r = await apiFetch(`/v1/cluster/nodes/${encodeURIComponent(nodeId)}/drain`, undefined, signal);
      await throwForStatus(r, 'GET /v1/cluster/nodes/{id}/drain');
      return (await r.json()) as DrainStatus;
    },
  });
}

export function useRemoveNode(): UseMutationResult<
  RemoveResult,
  Error,
  { nodeId: string; terminate: boolean; force: boolean }
> {
  const invalidate = useInvalidateCluster();
  return useMutation({
    mutationFn: async ({ nodeId, terminate, force }) => {
      const qs = new URLSearchParams({ terminate: String(terminate), force: String(force) });
      const r = await apiFetch(`/v1/cluster/nodes/${encodeURIComponent(nodeId)}?${qs.toString()}`, {
        method: 'DELETE',
      });
      await throwForStatus(r, 'DELETE /v1/cluster/nodes/{id}');
      return (await r.json()) as RemoveResult;
    },
    onSuccess: invalidate,
  });
}

// --- activity feed --------------------------------------------------------------

export function useClusterActivity(enabled: boolean): UseQueryResult<ActivityEvent[]> {
  return useQuery<ActivityEvent[]>({
    queryKey: ACTIVITY_QUERY_KEY,
    enabled,
    refetchInterval: 15_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const r = await apiFetch('/v1/cluster/activity?limit=50', undefined, signal);
      await throwForStatus(r, 'GET /v1/cluster/activity');
      const body = (await r.json()) as { events?: ActivityEvent[] };
      return Array.isArray(body.events) ? body.events : [];
    },
  });
}
