// Copyright OBSESC Authors
//
// Step 2 of onboarding: confirm the basic surfaces — /v1/health
// and /metrics — are reachable. Each row hits its endpoint directly
// and shows a live status chip the operator can refresh.

import { ReactElement } from 'react';
import { Box, Chip, Link, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';

export interface CheckRow {
  label: string;
  href: string;
  expect: string;
  /**
   * The status a HEALTHY node answers this GET probe with. `/v1/query` is
   * POST-only, so its healthy answer is a 405 — and a 405 badged in success
   * GREEN reads as a bug at a glance (U6). A probe whose healthy answer is
   * not 2xx must SAY so on the chip; it never borrows the pass colour.
   */
  healthyStatus: number;
  /** Why a non-2xx healthy status is the right answer. Rendered on the chip. */
  healthyNote?: string;
}

export const CHECKS: CheckRow[] = [
  {
    label: '/v1/health',
    href: '/obsesc-api/v1/health',
    expect: 'Responds 200 with body "ok" once the API is bound.',
    healthyStatus: 200,
  },
  {
    label: '/metrics',
    href: '/obsesc-api/metrics',
    expect: 'Prometheus text exposition. Look for obsesc_wal_committed_bytes_total (the honest throughput meter).',
    healthyStatus: 200,
  },
  {
    label: '/v1/query',
    href: '/obsesc-api/v1/query',
    expect: 'Accepts POST with a Query body. Used by the dashboards.',
    // A GET proves the route is MOUNTED without sending a query the
    // operator did not ask for; the node answers 405 Method Not Allowed.
    healthyStatus: 405,
    healthyNote: 'expected — POST only',
  },
];

function useEndpointStatus(path: string) {
  return useQuery({
    queryKey: ['obsesc-onboarding-check', path],
    refetchInterval: 10_000,
    queryFn: async () => {
      // GET on every row: for /v1/query that is a 405, which still proves
      // the route is mounted. The row declares what "healthy" means for it
      // (`healthyStatus`) rather than this probe treating any 405 as a pass.
      const res = await fetch(path);
      return { status: res.status };
    },
  });
}

export interface ProbeVerdict {
  tone: 'success' | 'info' | 'warning';
  label: string;
}

/**
 * The whole of U6, as one pure decision.
 *
 * The old rule was `res.ok || res.status === 405` feeding `color="success"`,
 * which put a green **HTTP 405** next to `/v1/query` — correct underneath
 * (the probe GETs a POST-only route) and indistinguishable from a bug at a
 * glance. Two rules replace it:
 *
 *   - success GREEN is reserved for a 2xx. Nothing else may borrow it.
 *   - a healthy NON-2xx is `info` and must carry its reason in the label,
 *     so "is this a pass?" is answered on the chip rather than inferred.
 */
export function probeVerdict(status: number, check: CheckRow): ProbeVerdict {
  if (status !== check.healthyStatus) return { tone: 'warning', label: `HTTP ${status}` };
  if (status >= 200 && status < 300) return { tone: 'success', label: `HTTP ${status}` };
  return { tone: 'info', label: `HTTP ${status} — ${check.healthyNote ?? 'expected'}` };
}

function StatusChip({ check }: { check: CheckRow }): ReactElement {
  const { data, isLoading, error } = useEndpointStatus(check.href);
  if (error) {
    return <Chip size="small" label="unreachable" color="error" variant="outlined" />;
  }
  if (isLoading || !data) {
    return <Chip size="small" label="checking…" variant="outlined" />;
  }
  const verdict = probeVerdict(data.status, check);
  return <Chip size="small" label={verdict.label} color={verdict.tone} variant="outlined" data-testid="probe-status" />;
}

export function HealthCheckStep(): ReactElement {
  return (
    <Stack gap={2}>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          2. Verify the node's surfaces
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Three endpoints are always there. If any of these don't respond, the
          rest of the UI won't work either — check the node process and security
          group first.
        </Typography>
      </Box>
      <Stack gap={1}>
        {CHECKS.map((c) => (
          <Stack
            key={c.label}
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            sx={{
              padding: 1.25,
              borderRadius: 1,
              border: '1px solid',
              borderColor: 'background.border',
            }}
          >
            <Box>
              <Typography
                variant="body2"
                sx={{ fontFamily: '"JetBrains Mono", monospace', fontWeight: 600 }}
              >
                <Link href={c.href} target="_blank" rel="noreferrer" underline="hover" color="inherit">
                  {c.label}
                </Link>
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {c.expect}
              </Typography>
            </Box>
            <StatusChip check={c} />
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
