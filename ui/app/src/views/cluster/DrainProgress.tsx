// Copyright OBSESC Authors
//
// Live drain progress — REAL numbers from GET /v1/cluster/nodes/{id}/drain
// (open summary buckets + WAL backlog bytes), polled every 2s while the
// drain runs. No indeterminate spinner theatre: the operator watches the
// backlog converge to zero, and "drained" is the server saying so.

import { ReactElement } from 'react';
import { Alert, Chip, Stack, Typography } from '@mui/material';
import { useDrainStatus } from './use-cluster';
import { bytesPretty } from './format';

interface DrainProgressProps {
  nodeId: string;
  /** Poll only while the drain surface is visible. */
  enabled: boolean;
  /** Compact single-line variant for the membership table row. */
  dense?: boolean;
}

export function DrainProgress({ nodeId, enabled, dense = false }: DrainProgressProps): ReactElement {
  const { data, error } = useDrainStatus(nodeId, enabled);

  if (error) {
    return dense ? (
      <Typography variant="caption" color="text.secondary">
        drain status unavailable
      </Typography>
    ) : (
      <Alert severity="warning" variant="outlined">
        Couldn&apos;t read drain progress: {error instanceof Error ? error.message : String(error)}
      </Alert>
    );
  }
  if (!data) {
    return (
      <Typography variant="caption" color="text.secondary">
        reading drain status…
      </Typography>
    );
  }

  if (data.status === 'drained') {
    return dense ? (
      <Chip size="small" color="success" variant="outlined" label="drained" />
    ) : (
      <Alert severity="success" variant="outlined">
        Drained — no open buckets, WAL backlog flushed. Safe to remove.
      </Alert>
    );
  }
  if (data.status === 'active') {
    // Honest state: the server hasn't registered a drain (yet). The poll
    // keeps running while this surface is visible, so a just-started drain
    // flips to real numbers on the next tick.
    return dense ? (
      <Typography variant="caption" color="text.secondary">
        drain not registered — node still active
      </Typography>
    ) : (
      <Typography variant="body2" color="text.secondary">
        The node still reports <strong>active</strong> — no drain in progress. If you just started one, this updates
        within a couple of seconds.
      </Typography>
    );
  }
  if (data.status === 'down') {
    return dense ? (
      <Chip size="small" color="error" variant="outlined" label="down" />
    ) : (
      <Alert severity="error" variant="outlined">
        The node stopped answering mid-drain — its buffered data can&apos;t be confirmed flushed. Removing it now
        requires force.
      </Alert>
    );
  }

  const line = `${data.open_buckets} open bucket${data.open_buckets === 1 ? '' : 's'} · ${bytesPretty(data.wal_backlog_bytes)} WAL backlog`;
  return dense ? (
    <Typography variant="caption" sx={{ color: 'warning.main' }}>
      draining — {line}
    </Typography>
  ) : (
    <Stack gap={0.5}>
      <Typography variant="body2" sx={{ color: 'warning.main' }}>
        Draining — {line}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Ingest is routed away; the node flushes what it holds. Both numbers converge to zero, then the status flips to
        &quot;drained&quot;.
      </Typography>
    </Stack>
  );
}
