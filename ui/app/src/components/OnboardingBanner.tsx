// Copyright OBSESC Authors
//
// Persistent dismissible banner shown above every dashboard while
// the node hasn't received any events yet and the operator hasn't
// dismissed it. Hidden on /onboarding itself (they're already
// there) and once ingest crosses zero (the data proves it worked).

import { ReactElement } from 'react';
import { Box, Button, IconButton, Stack, Typography } from '@mui/material';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import Close from 'mdi-material-ui/Close';
import ArrowRight from 'mdi-material-ui/ArrowRight';
import { useOnboarded } from '../views/onboarding/use-onboarded';

export function OnboardingBanner(): ReactElement | null {
  const { bannerVisible, dismissBanner } = useOnboarded();
  const { pathname } = useLocation();

  // Don't shout the same message on the very page that tells it.
  if (!bannerVisible || pathname.startsWith('/onboarding')) {
    return null;
  }

  return (
    <Box
      sx={{
        backgroundColor: 'rgba(245, 158, 11, 0.12)', // amber-tinted
        borderBottom: '1px solid',
        borderColor: 'rgba(245, 158, 11, 0.35)',
        padding: '8px 16px',
      }}
    >
      <Stack direction="row" alignItems="center" gap={2} justifyContent="space-between">
        <Stack direction="row" alignItems="center" gap={1.5}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            No ingest yet.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Send your first event so the dashboards can light up.
          </Typography>
          <Button
            component={RouterLink}
            to="/onboarding"
            size="small"
            variant="text"
            color="primary"
            endIcon={<ArrowRight />}
            sx={{ fontWeight: 600 }}
          >
            Open onboarding
          </Button>
        </Stack>
        <IconButton size="small" onClick={dismissBanner} aria-label="Dismiss onboarding banner">
          <Close fontSize="small" />
        </IconButton>
      </Stack>
    </Box>
  );
}
