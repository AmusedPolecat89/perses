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
  // Bytes/sec ingest across all sources (instantaneous, not rate()'d
  // — we have a single scrape so we can't compute a rate locally).
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
  // Raw text for the troubleshooting modal.
  rawMetrics: string;
}

const METRICS_URL = '/obsesc-api/metrics';
const HEALTH_URL = '/obsesc-api/v1/health';

function parsePrometheus(text: string): NodeStats {
  const lines = text.split('\n');
  const stats: NodeStats = {
    healthy: true,
    totalIngestBytesCumulative: 0,
    bytesBySource: {},
    budgets: {},
    walShards: [],
    summaryBucketsOpen: 0,
    dispatchLag: { items: 0, capacity: 0, ratio: 0 },
    s3PutErrors: 0,
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

export function useNodeStats(refetchIntervalMs = 5_000): UseQueryResult<NodeStats> {
  return useQuery<NodeStats>({
    queryKey: ['obsesc-node-stats'],
    refetchInterval: refetchIntervalMs,
    queryFn: async () => {
      const [healthRes, metricsRes] = await Promise.all([
        fetch(HEALTH_URL),
        fetch(METRICS_URL),
      ]);
      if (!metricsRes.ok) {
        throw new Error(`metrics fetch failed: HTTP ${metricsRes.status}`);
      }
      const text = await metricsRes.text();
      const stats = parsePrometheus(text);
      stats.healthy = healthRes.ok;
      return stats;
    },
  });
}
