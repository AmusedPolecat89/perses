// Copyright OBSESC Authors
//
// Onboarding page — three steps the operator works through once.
// Linked from the persistent banner that shows on every dashboard
// while no ingest has been seen, and from the header so it's always
// reachable for handoff scenarios.

import { ReactElement } from 'react';
import { Box, Button, Divider, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { ANOMALIES_DASHBOARD_NAME, dashboardRoute, NODEHEALTH_DASHBOARD_NAME } from '../../model/project';
import { CurlSendStep } from './CurlSendStep';
import { HealthCheckStep } from './HealthCheckStep';
import { ShipperConfigs } from './ShipperConfigs';
import { useOnboarded } from './use-onboarded';

export default function OnboardingView(): ReactElement {
  const { isComplete, markComplete, reopenOnboarding } = useOnboarded();

  return (
    <Box sx={{ padding: 3, maxWidth: 920, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-end" sx={{ mb: 1 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
            Onboarding
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {isComplete
              ? 'This node has received events. Re-open these steps if you need to verify the pipeline again.'
              : 'Three steps to get this node receiving events and visible in the dashboards.'}
          </Typography>
        </Box>
        {isComplete ? (
          <Button variant="outlined" color="inherit" onClick={reopenOnboarding}>
            Re-show banner
          </Button>
        ) : (
          <Button variant="outlined" color="inherit" onClick={markComplete}>
            Mark complete
          </Button>
        )}
      </Stack>

      <Stack gap={3} sx={{ mt: 2 }}>
        <CurlSendStep />
        <Divider />
        <HealthCheckStep />
        <Divider />
        <ShipperConfigs />
      </Stack>

      <Divider sx={{ mt: 4, mb: 2 }} />

      <Box>
        <Typography variant="overline" color="text.secondary">
          Where to go next
        </Typography>
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>
          <Button
            component={RouterLink}
            to={dashboardRoute(NODEHEALTH_DASHBOARD_NAME)}
            variant="contained"
          >
            Node health dashboard
          </Button>
          <Button
            component={RouterLink}
            to={dashboardRoute(ANOMALIES_DASHBOARD_NAME)}
            variant="outlined"
            color="inherit"
          >
            Anomaly feed
          </Button>
          <Button component={RouterLink} to="/cluster" variant="outlined" color="inherit">
            Cluster
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}
