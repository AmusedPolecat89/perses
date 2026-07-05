// Copyright OBSESC Authors
//
// Cluster activity feed — the operator audit trail from
// GET /v1/cluster/activity (newest-first): who did what to which node,
// when, and what it did to the monthly bill.

import { ReactElement } from 'react';
import { Alert, Box, Chip, CircularProgress, Stack, Tooltip, Typography } from '@mui/material';
import RocketLaunchOutline from 'mdi-material-ui/RocketLaunchOutline';
import WaterOutline from 'mdi-material-ui/WaterOutline';
import MinusCircleOutline from 'mdi-material-ui/MinusCircleOutline';
import PowerPlugOff from 'mdi-material-ui/PowerPlugOff';
import { ActivityAction, useClusterActivity } from './use-cluster';
import { relativeTime, usdDeltaPretty } from './format';

const ACTION_META: Record<ActivityAction, { label: string; Icon: typeof RocketLaunchOutline }> = {
  launch: { label: 'launch', Icon: RocketLaunchOutline },
  drain: { label: 'drain', Icon: WaterOutline },
  remove_node: { label: 'remove', Icon: MinusCircleOutline },
  terminate: { label: 'terminate', Icon: PowerPlugOff },
};

export function ActivityFeedCard({ enabled }: { enabled: boolean }): ReactElement {
  const { data: events, isLoading, error } = useClusterActivity(enabled);

  return (
    <Box
      sx={{
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: 'background.border',
        backgroundColor: 'background.paper',
        padding: 2.5,
        mt: 3,
      }}
    >
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        Cluster activity
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Node launches, drains and removals — newest first, with each action&apos;s approximate monthly cost impact.
      </Typography>

      {!enabled && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Available once the cluster control plane is enabled on this node.
        </Typography>
      )}
      {enabled && isLoading && (
        <Box sx={{ mt: 2 }}>
          <CircularProgress size={18} />
        </Box>
      )}
      {enabled && error !== null && error !== undefined && (
        <Alert severity="warning" variant="outlined" sx={{ mt: 2 }}>
          Couldn&apos;t load the activity feed: {error instanceof Error ? error.message : String(error)}
        </Alert>
      )}
      {enabled && events && events.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          No cluster actions recorded yet — launches, drains and removals will show up here.
        </Typography>
      )}
      {enabled && events && events.length > 0 && (
        <Stack gap={1.25} sx={{ mt: 2 }}>
          {events.map((ev, i) => {
            const meta = ACTION_META[ev.action] ?? {
              label: ev.action,
              Icon: RocketLaunchOutline,
            };
            const Icon = meta.Icon;
            return (
              <Stack key={`${ev.ts_ms}-${ev.node_id}-${i}`} direction="row" alignItems="center" gap={1.25}>
                <Icon fontSize="small" sx={{ color: 'text.secondary' }} />
                <Tooltip title={new Date(ev.ts_ms).toISOString()}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ minWidth: 72, fontFamily: '"JetBrains Mono", monospace' }}
                  >
                    {relativeTime(ev.ts_ms)}
                  </Typography>
                </Tooltip>
                <Chip size="small" variant="outlined" label={meta.label} />
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                  <strong>{ev.node_id}</strong>
                  {ev.detail ? ` — ${ev.detail}` : ''}
                  <Typography component="span" variant="caption" color="text.secondary">
                    {' '}
                    · {ev.actor}
                  </Typography>
                </Typography>
                {ev.cost_delta_monthly_usd !== undefined && (
                  <Chip
                    size="small"
                    variant="outlined"
                    color={ev.cost_delta_monthly_usd > 0 ? 'warning' : 'success'}
                    label={`${usdDeltaPretty(ev.cost_delta_monthly_usd)} approx`}
                  />
                )}
              </Stack>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
