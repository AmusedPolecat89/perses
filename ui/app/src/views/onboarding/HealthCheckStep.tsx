// Copyright OBSESC Authors
//
// Step 2 of onboarding: confirm the basic surfaces — /v1/health
// and /metrics — are reachable. Each row hits its endpoint directly
// and shows a live status chip the operator can refresh.

import { ReactElement } from 'react';
import { Box, Chip, Link, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';

interface CheckRow {
  label: string;
  href: string;
  expect: string;
}

const CHECKS: CheckRow[] = [
  {
    label: '/v1/health',
    href: '/obsesc-api/v1/health',
    expect: 'Responds 200 with body "ok" once the API is bound.',
  },
  {
    label: '/metrics',
    href: '/obsesc-api/metrics',
    expect: 'Prometheus text exposition. Look for obsesc_ingest_bytes_total.',
  },
  {
    label: '/v1/query',
    href: '/obsesc-api/v1/query',
    expect: 'Accepts POST with a Query body. Used by the dashboards.',
  },
];

function useEndpointStatus(path: string) {
  return useQuery({
    queryKey: ['obsesc-onboarding-check', path],
    refetchInterval: 10_000,
    queryFn: async () => {
      // GET is fine for /v1/health and /metrics; for /v1/query it's
      // a 405 (Method Not Allowed) which still proves the route is
      // mounted — that's what we want for the check.
      const res = await fetch(path);
      return { ok: res.ok || res.status === 405, status: res.status };
    },
  });
}

function StatusChip({ path }: { path: string }): ReactElement {
  const { data, isLoading, error } = useEndpointStatus(path);
  if (error) {
    return <Chip size="small" label="unreachable" color="error" variant="outlined" />;
  }
  if (isLoading || !data) {
    return <Chip size="small" label="checking…" variant="outlined" />;
  }
  if (data.ok) {
    return <Chip size="small" label={`HTTP ${data.status}`} color="success" variant="outlined" />;
  }
  return <Chip size="small" label={`HTTP ${data.status}`} color="warning" variant="outlined" />;
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
            <StatusChip path={c.href} />
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
