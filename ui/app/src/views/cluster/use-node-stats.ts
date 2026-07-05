// Copyright OBSESC Authors
//
// Pulls live node stats directly from obsesc-api's /metrics endpoint.
// We hit /metrics rather than Prometheus so the NodeManager works
// even on a fresh AMI before any external monitoring is wired —
// the brief explicitly calls /metrics out as the guaranteed surface.

import { useQuery, UseQueryResult } from '@tanstack/react-query';

export interface NodeStats {
  // True if /v1/health returned 200 recently.
  healthy: boolean;
  // Cumulative bytes durably committed through the WAL checkpoint —
  // the HONEST meter (received counts pre-admission and over-reads
  // under shed). Summed across shards.
  committedBytesCumulative: number;
  // Committed MB/s derived from the delta between this poll and the
  // previous one. null until two samples exist.
  committedMBps: number | null;
  // from_raw driver lag: committed raw files not yet summarised.
  summaryBacklogFiles: number;
  // Received (pre-admission) cumulative bytes across all sources.
  totalIngestBytesCumulative: number;
  // Per-source instantaneous cumulative bytes.
  bytesBySource: Record<string, number>;
  // Memory budget snapshots — subsystem → { current, limit, pct }.
  budgets: Record<string, { current: number; limit: number; pct: number }>;
  // WAL checkpoint position per shard.
  walShards: Array<{ shard: string; segment: number; offset: number }>;
  // Currently-open summary buckets.
  summaryBucketsOpen: number;
  // Dispatch channel lag (items / capacity / ratio).
  dispatchLag: { items: number; capacity: number; ratio: number };
  // Cumulative S3 PUT errors from the raw writer.
  s3PutErrors: number;
  // From obsesc_node_info{instance_type,role} 1 (control-plane nodes).
  // null on older nodes that don't export it — callers fall back to an
  // estimate and must LABEL it as such.
  instanceType: string | null;
  // From obsesc_node_info{role} — 'ingest' | 'query' | 'all' on the wire.
  nodeRole: string | null;
  // Raw text for the troubleshooting modal.
  rawMetrics: string;
}

const METRICS_URL = '/obsesc-api/metrics';
const HEALTH_URL = '/obsesc-api/v1/health';

function parsePrometheus(text: string): NodeStats {
  const lines = text.split('\n');
  const stats: NodeStats = {
    healthy: true,
    committedBytesCumulative: 0,
    committedMBps: null,
    summaryBacklogFiles: 0,
    totalIngestBytesCumulative: 0,
    bytesBySource: {},
    budgets: {},
    walShards: [],
    summaryBucketsOpen: 0,
    dispatchLag: { items: 0, capacity: 0, ratio: 0 },
    s3PutErrors: 0,
    instanceType: null,
    nodeRole: null,
    rawMetrics: text,
  };
  const budgetCurrent: Record<string, number> = {};
  const budgetLimit: Record<string, number> = {};

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    // metric{labels} value [timestamp]
    const match = line.match(/^([a-zA-Z0-9_:]+)(\{[^}]*\})?\s+([^\s]+)/);
    if (!match) continue;
    const [, name, labelsRaw, valueRaw] = match;
    const value = Number(valueRaw);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    if (labelsRaw) {
      for (const pair of labelsRaw.slice(1, -1).split(',')) {
        const m = pair.match(/^([a-zA-Z0-9_]+)="([^"]*)"$/);
        if (m) labels[m[1]!] = m[2]!;
      }
    }

    switch (name) {
      case 'obsesc_ingest_bytes_total':
        stats.totalIngestBytesCumulative += value;
        if (labels.source) stats.bytesBySource[labels.source] = value;
        break;
      case 'obsesc_memory_budget_current_bytes':
        if (labels.subsystem) budgetCurrent[labels.subsystem] = value;
        break;
      case 'obsesc_memory_budget_limit_bytes':
        if (labels.subsystem) budgetLimit[labels.subsystem] = value;
        break;
      case 'obsesc_wal_checkpoint_segment':
        if (labels.shard) {
          const existing = stats.walShards.find((s) => s.shard === labels.shard);
          if (existing) existing.segment = value;
          else stats.walShards.push({ shard: labels.shard, segment: value, offset: 0 });
        }
        break;
      case 'obsesc_wal_checkpoint_offset':
        if (labels.shard) {
          const existing = stats.walShards.find((s) => s.shard === labels.shard);
          if (existing) existing.offset = value;
          else stats.walShards.push({ shard: labels.shard, segment: 0, offset: value });
        }
        break;
      case 'obsesc_wal_committed_bytes':
        stats.committedBytesCumulative += value;
        break;
      case 'obsesc_summary_unsummarised_backlog_files':
        stats.summaryBacklogFiles = value;
        break;
      case 'obsesc_summary_buckets_open':
        stats.summaryBucketsOpen = value;
        break;
      case 'obsesc_dispatch_lag_items':
        stats.dispatchLag.items = value;
        break;
      case 'obsesc_dispatch_lag_capacity':
        stats.dispatchLag.capacity = value;
        break;
      case 'obsesc_dispatch_lag':
        stats.dispatchLag.ratio = value;
        break;
      case 'obsesc_s3_put_errors_total':
        stats.s3PutErrors = value;
        break;
      case 'obsesc_node_info':
        // Info-style metric: labels carry the payload, value is always 1.
        if (labels.instance_type) stats.instanceType = labels.instance_type;
        if (labels.role) stats.nodeRole = labels.role;
        break;
    }
  }

  for (const subsystem of Object.keys(budgetCurrent)) {
    const current = budgetCurrent[subsystem] ?? 0;
    const limit = budgetLimit[subsystem] ?? 0;
    const pct = limit > 0 ? current / limit : 0;
    stats.budgets[subsystem] = { current, limit, pct };
  }

  stats.walShards.sort((a, b) => a.shard.localeCompare(b.shard));
  return stats;
}

// Previous committed-bytes sample, module-scoped so the rate survives
// component remounts. A single scrape can't rate() itself; two can.
let prevCommitted: { bytes: number; atMs: number } | null = null;

export function useNodeStats(refetchIntervalMs = 5_000): UseQueryResult<NodeStats> {
  return useQuery<NodeStats>({
    queryKey: ['obsesc-node-stats'],
    refetchInterval: refetchIntervalMs,
    queryFn: async () => {
      const [healthRes, metricsRes] = await Promise.all([fetch(HEALTH_URL), fetch(METRICS_URL)]);
      if (!metricsRes.ok) {
        throw new Error(`metrics fetch failed: HTTP ${metricsRes.status}`);
      }
      const text = await metricsRes.text();
      const stats = parsePrometheus(text);
      stats.healthy = healthRes.ok;
      const now = Date.now();
      if (prevCommitted && now > prevCommitted.atMs) {
        const dBytes = stats.committedBytesCumulative - prevCommitted.bytes;
        const dSec = (now - prevCommitted.atMs) / 1000;
        // Negative delta = node restarted (gauge reset); skip that sample.
        stats.committedMBps = dBytes >= 0 ? dBytes / dSec / 1024 / 1024 : null;
      }
      prevCommitted = { bytes: stats.committedBytesCumulative, atMs: now };
      return stats;
    },
  });
}
