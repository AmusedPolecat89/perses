// Copyright OBSESC Authors
//
// One card per node in the NodeManager grid. Reads the parsed
// /metrics + /v1/health snapshot from useNodeStats() and renders
// instance role, ingest, budget %s, WAL position, and a "Resize"
// action button.

import { ReactElement } from 'react';
import {
  Box,
  Button,
  Chip,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { NodeStats } from './use-node-stats';
import { findInstance, monthlyUsd } from './instance-types';

interface NodeCardProps {
  name: string;
  instanceId: string;
  stats: NodeStats | undefined;
  isLoading: boolean;
  error: unknown;
  /// Peer member (from /v1/cluster) whose stats aren't scraped from this
  /// browser session — renders a membership card with the advertised addr
  /// instead of live gauges.
  peerAddr?: string;
  onResize: () => void;
}

function bytesPretty(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)} ${units[i]}`;
}

// Sources that have actually sent bytes — the meter reports all eight
// protocol labels including the zeros, which read as noise on the card.
function activeSources(bySource: Record<string, number>): number {
  return Object.values(bySource).filter((v) => v > 0).length;
}

function budgetColor(pct: number): 'success' | 'warning' | 'error' {
  if (pct >= 0.9) return 'error';
  if (pct >= 0.8) return 'warning';
  return 'success';
}

export function NodeCard({
  name,
  instanceId,
  stats,
  isLoading,
  error,
  peerAddr,
  onResize,
}: NodeCardProps): ReactElement {
  const spec = findInstance(instanceId);
  const healthy = stats?.healthy ?? false;
  const totalBytes = stats?.totalIngestBytesCumulative ?? 0;
  const budgets = stats?.budgets ?? {};

  // A peer member: in the ring (that's how we know about it), but its
  // gauges aren't scraped from this browser session.
  if (peerAddr !== undefined) {
    return (
      <Box
        sx={{
          borderRadius: 1.5,
          border: '1px solid',
          borderColor: 'background.border',
          backgroundColor: 'background.paper',
          padding: 2.5,
          minWidth: 360,
        }}
      >
        <Stack direction="row" alignItems="center" gap={1}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            {name}
          </Typography>
          <Chip size="small" label="active member" color="success" variant="outlined" />
        </Stack>
        <Typography variant="caption" color="text.secondary">
          peer · {peerAddr || 'no advertised address'}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          In the ring at the current epoch. Open this node&apos;s own dashboard for
          its live gauges.
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: 'background.border',
        backgroundColor: 'background.paper',
        padding: 2.5,
        minWidth: 360,
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
        <Box>
          <Stack direction="row" alignItems="center" gap={1}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              {name}
            </Typography>
            {error ? (
              <Chip size="small" label="unreachable" color="error" variant="outlined" />
            ) : healthy ? (
              <Chip size="small" label="healthy" color="success" variant="outlined" />
            ) : (
              <Chip size="small" label="checking…" variant="outlined" />
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {spec ? `${spec.id} · ${spec.vcpu} vCPU / ${spec.memoryGb} GB` : instanceId}{' '}
            {spec && `· approx $${monthlyUsd(spec).toFixed(0)}/mo`}
          </Typography>
        </Box>
        <Button variant="outlined" size="small" onClick={onResize}>
          → Resize
        </Button>
      </Stack>

      <Box sx={{ mt: 2 }}>
        <Typography variant="overline" color="text.secondary">
          Committed throughput
        </Typography>
        <Typography variant="body1">
          {isLoading && !stats
            ? '…'
            : stats?.committedMBps == null
              ? 'measuring…'
              : `${stats.committedMBps.toFixed(1)} MB/s committed`}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {stats
            ? `${bytesPretty(stats.committedBytesCumulative)} committed total · ${bytesPretty(totalBytes)} received (pre-admission) from ${activeSources(stats.bytesBySource)} source${activeSources(stats.bytesBySource) === 1 ? '' : 's'}`
            : ''}
        </Typography>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <Typography variant="overline" color="text.secondary">
          Memory budgets
        </Typography>
        <Stack gap={0.75} sx={{ mt: 0.5 }}>
          {Object.entries(budgets).length === 0 && (
            <Typography variant="caption" color="text.secondary">
              awaiting first scrape
            </Typography>
          )}
          {Object.entries(budgets).map(([subsystem, b]) => (
            <Box key={subsystem}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="caption">{subsystem}</Typography>
                <Typography variant="caption" sx={{ fontFamily: '"JetBrains Mono", monospace' }}>
                  {(b.pct * 100).toFixed(1)}%
                </Typography>
              </Stack>
              <Tooltip title={`${bytesPretty(b.current)} of ${bytesPretty(b.limit)}`}>
                <LinearProgress
                  variant="determinate"
                  value={Math.min(100, b.pct * 100)}
                  color={budgetColor(b.pct)}
                  sx={{ height: 4, borderRadius: 2 }}
                />
              </Tooltip>
            </Box>
          ))}
        </Stack>
      </Box>

      <Stack direction="row" gap={3} sx={{ mt: 1.5 }}>
        <Box>
          <Typography variant="overline" color="text.secondary">
            Summary backlog
          </Typography>
          <Tooltip title="Committed raw files the from_raw driver hasn't summarised yet — lag is by design under burst; raw never throttles.">
            <Typography
              variant="body2"
              sx={{
                color: (stats?.summaryBacklogFiles ?? 0) > 500 ? 'error.main' : undefined,
              }}
            >
              {stats ? `${stats.summaryBacklogFiles} files` : '—'}
            </Typography>
          </Tooltip>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            Summary buckets
          </Typography>
          <Typography variant="body2">{stats?.summaryBucketsOpen ?? '—'}</Typography>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            Dispatch lag
          </Typography>
          <Typography variant="body2">
            {stats ? `${(stats.dispatchLag.ratio * 100).toFixed(2)}%` : '—'}
          </Typography>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            WAL shards
          </Typography>
          <Typography variant="body2">
            {stats?.walShards.length ? `${stats.walShards.length} active` : '—'}
          </Typography>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            S3 PUT errors
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: (stats?.s3PutErrors ?? 0) > 0 ? 'error.main' : undefined,
            }}
          >
            {stats?.s3PutErrors ?? 0}
          </Typography>
        </Box>
      </Stack>
    </Box>
  );
}
