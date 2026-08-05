// Copyright OBSESC Authors
//
// /alerts — persisted window-cadence alert state (Lane U1). One table over
// GET /v1/alerts: server-side status filter, firing-first ordering, human
// summaries prominent. Freshness floors at window flush — this is not a
// realtime pager, and the copy says so.
//
// Tri-state contract (PR standard #4): loading ≠ failed ≠ empty ≠ disabled
// (via useCapabilities()) ≠ node-unreachable — five distinct renders below.
//
// There is NO alerting config API: rules, predicates and destinations live
// in config.yaml on the node. The disabled state explains that honestly
// instead of faking a settings surface.

import { ReactElement, useMemo, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Link,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { AsyncOpStatus } from '../../components/progress/AsyncOp';
import { useTrackedOp } from '../../components/progress/useAsyncOp';
import { useCapabilities } from '../../hooks/use-capabilities';
import { dashboardRoute } from '../../model/project';
import {
  ALERTS_LIMIT_MAX,
  AlertStatus,
  AlertStatusFilter,
  ObsescAlert,
  useAlerts,
} from './use-alerts';

const mono = { fontFamily: '"JetBrains Mono", monospace' } as const;

const card = {
  borderRadius: 1.5,
  border: '1px solid',
  borderColor: 'background.border',
  backgroundColor: 'background.paper',
  padding: 2.5,
} as const;

const STATUS_FILTERS: AlertStatusFilter[] = ['all', 'firing', 'pending', 'resolved'];
/** Never offer more than the server-side cap (1000 → 400 above). */
const LIMIT_CHOICES = [100, 500, ALERTS_LIMIT_MAX];
/** firing-first, then pending, resolved last; recency breaks ties. */
const STATUS_RANK: Record<AlertStatus, number> = { firing: 0, pending: 1, resolved: 2 };

function isStatusFilter(v: string | null): v is AlertStatusFilter {
  return v !== null && (STATUS_FILTERS as string[]).includes(v);
}

/** ns epoch → local wall-clock, seconds precision. */
function tsLocal(ns: number): string {
  return new Date(ns / 1e6).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function StatusChip({ status }: { status: AlertStatus }): ReactElement {
  // firing = red/amber per theme; pending = muted outline; resolved = grey.
  if (status === 'firing') {
    return <Chip size="small" color="error" label="firing" />;
  }
  if (status === 'pending') {
    return <Chip size="small" variant="outlined" label="pending" sx={{ color: 'text.secondary' }} />;
  }
  return <Chip size="small" label="resolved" sx={{ color: 'text.secondary' }} />;
}

function AlertRow({ alert }: { alert: ObsescAlert }): ReactElement {
  return (
    <TableRow hover>
      <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
        <StatusChip status={alert.status} />
      </TableCell>
      <TableCell sx={{ verticalAlign: 'top' }}>
        {/* The human summary is the headline; rule + series are the fine print. */}
        <Typography variant="body1" sx={{ fontWeight: 500 }}>
          {alert.summary}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={mono}>
          {alert.rule}
          {alert.series && alert.series !== alert.service ? ` · ${alert.series}` : ''}
        </Typography>
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
        <Chip size="small" variant="outlined" label={alert.predicate} sx={mono} />
      </TableCell>
      <TableCell sx={{ verticalAlign: 'top' }}>
        {/* Pivot to the service-health dashboard (plan: "service links"). */}
        <Link
          component={RouterLink}
          to={dashboardRoute('servicehealth')}
          underline="hover"
          variant="body2"
          sx={mono}
        >
          {alert.service}
        </Link>
      </TableCell>
      <TableCell align="right" sx={{ verticalAlign: 'top' }}>
        <Typography variant="body2" sx={mono}>
          {alert.consecutive_windows}
        </Typography>
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
        <Tooltip title={`window ${tsLocal(alert.window_start_ns)} → ${tsLocal(alert.window_end_ns)}`}>
          <Typography variant="body2">{tsLocal(alert.window_end_ns)}</Typography>
        </Tooltip>
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
        {alert.resolved_window_start_ns !== undefined ? (
          <Typography variant="body2" color="text.secondary">
            resolved {tsLocal(alert.resolved_window_start_ns)}
          </Typography>
        ) : alert.fired_window_start_ns !== undefined ? (
          <Typography variant="body2">fired {tsLocal(alert.fired_window_start_ns)}</Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            —
          </Typography>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Alerting is off in the node's config — the honest, designed empty state. */
function DisabledState(): ReactElement {
  return (
    <Box sx={{ ...card, maxWidth: 720 }}>
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        Alerting is not enabled on this node
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        Alert rules, predicates (novelty, behavioral, predictive) and delivery
        destinations are configured in <Box component="code" sx={mono}>config.yaml</Box> on
        the node, under the <Box component="code" sx={mono}>alerting</Box> section. There is
        no configuration API — edit the node&apos;s config file and restart the
        process; this page will light up on its own once the node reports
        alerting enabled.
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
        Alerts evaluate at window flush — state here is per summary window, not
        a realtime pager.
      </Typography>
    </Box>
  );
}

/** Capabilities probe failed — this is "node down", not "alerting off". */
function UnreachableState(): ReactElement {
  return (
    <Box sx={{ ...card, maxWidth: 720 }}>
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        Node unreachable
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        The OBSESC node did not answer the capability probe, so whether
        alerting is enabled is unknown. Check that the node process is up and
        that this UI can reach <Box component="code" sx={mono}>/obsesc-api</Box>, then
        reload the page to probe again.
      </Typography>
    </Box>
  );
}

const EMPTY_COPY: Record<AlertStatusFilter, string> = {
  all: 'No alerts recorded yet. Rules evaluate at each summary window flush — this stays empty until a configured predicate trips.',
  firing: 'Nothing is firing. Alerts that trip their predicate for enough consecutive windows will appear here.',
  pending: 'No pending alerts — nothing is partway through its consecutive-window threshold.',
  resolved: 'No resolved alerts. Alerts that fired and then recovered land here.',
};

export default function AlertsView(): ReactElement {
  const caps = useCapabilities();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlStatus = searchParams.get('status');
  const status: AlertStatusFilter = isStatusFilter(urlStatus) ? urlStatus : 'all';
  const [limit, setLimit] = useState<number>(500);

  const alertsEnabled = !caps.isLoading && !caps.unavailable && caps.alerting;
  const query = useAlerts(status, limit, alertsEnabled);
  // The refresh/Retry wait gets the same staged disclosure as every other
  // operation: a bar at 400 ms, elapsed + Cancel at 2 s, a receipt when it
  // lands. No Cancel here — react-query owns the fetch.
  const refreshOp = useTrackedOp(query.isFetching, {
    error: query.isError ? query.error : null,
    receipt:
      query.data === undefined
        ? null
        : `${query.data.alerts.length} alert${query.data.alerts.length === 1 ? '' : 's'} of ${
            query.data.total
          }`,
  });

  const sorted = useMemo(() => {
    const alerts = query.data?.alerts ?? [];
    return [...alerts].sort(
      (a, b) =>
        (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) ||
        b.window_end_ns - a.window_end_ns
    );
  }, [query.data]);

  const total = query.data?.total ?? 0;
  const truncated = query.data !== undefined && total > sorted.length;

  return (
    <Box sx={{ padding: 3, maxWidth: 1280, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-end" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
            Alerts
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Window-cadence alert state from this node&apos;s rules — freshness floors
            at summary-window flush. Refreshes every 15s.
          </Typography>
        </Box>
        {alertsEnabled && (
          <Stack direction="row" alignItems="center" gap={1.5}>
            {/* Transient poll blip with data on screen: keep the table,
                flag the staleness — don't blank to the error state. */}
            {query.isError && query.data !== undefined && (
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                label="last refresh failed — showing previous data"
              />
            )}
            {query.data !== undefined && (
              <AsyncOpStatus
                id="alerts-refresh"
                state={refreshOp}
                label="Refresh"
                runningHint="Refreshing alerts…"
              />
            )}
            <ToggleButtonGroup
              size="small"
              exclusive
              value={status}
              aria-label="Alert status filter"
              onChange={(_e, v: AlertStatusFilter | null) => {
                if (v !== null) {
                  setSearchParams(v === 'all' ? {} : { status: v }, { replace: true });
                }
              }}
            >
              {STATUS_FILTERS.map((s) => (
                <ToggleButton key={s} value={s} sx={{ textTransform: 'none', px: 1.5 }}>
                  {s === 'all' ? 'All' : s}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <TextField
              select
              size="small"
              label="Limit"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              sx={{ width: 100 }}
            >
              {LIMIT_CHOICES.map((n) => (
                <MenuItem key={n} value={n}>
                  {n}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        )}
      </Stack>

      {/* Tri-state (standard 4): loading / unreachable / disabled / failed /
          empty / data — each with distinct copy. */}
      {caps.isLoading ? (
        <Stack direction="row" alignItems="center" gap={1.5} sx={{ mt: 4 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            Checking node capabilities…
          </Typography>
        </Stack>
      ) : caps.unavailable ? (
        <UnreachableState />
      ) : !caps.alerting ? (
        <DisabledState />
      ) : query.isError && query.data === undefined ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
          Alerting is enabled, but the alerts request failed: {String(query.error)}
        </Alert>
      ) : query.data === undefined ? (
        <Stack direction="row" alignItems="center" gap={1.5} sx={{ mt: 4 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            Loading alerts…
          </Typography>
        </Stack>
      ) : sorted.length === 0 ? (
        <Box sx={{ ...card, maxWidth: 720 }}>
          <Typography variant="body2" color="text.secondary">
            {EMPTY_COPY[status]}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ ...card, padding: 0, overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Status</TableCell>
                <TableCell>Alert</TableCell>
                <TableCell>Predicate</TableCell>
                <TableCell>Service</TableCell>
                <TableCell align="right">
                  <Tooltip title="Consecutive windows the predicate has held">
                    <span>Windows</span>
                  </Tooltip>
                </TableCell>
                <TableCell>Last window</TableCell>
                <TableCell>Fired / resolved</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sorted.map((a) => (
                <AlertRow key={`${a.rule}\u0000${a.series}\u0000${a.window_start_ns}`} alert={a} />
              ))}
            </TableBody>
          </Table>
          {truncated && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', px: 2, py: 1 }}
            >
              Showing {sorted.length} of {total} matching alerts
              {limit < ALERTS_LIMIT_MAX
                ? ' — raise the limit or narrow the filter to see more.'
                : ` — ${ALERTS_LIMIT_MAX} is the server-side maximum; narrow the filter to see the rest.`}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}
