// Copyright OBSESC Authors
//
// Persistent dismissible banner shown above every dashboard while
// the node holds NO DATA AT ALL and the operator hasn't dismissed
// it. Hidden on /onboarding itself (they're already there) and as
// soon as the node can show that events landed (the data proves it
// worked).
//
// "Holds no data" is `useOnboarded`'s job and it is a claim about
// storage, not about traffic: this banner once told a cluster with
// 9.17 TB stored and 11.6 TB committed that there was "no ingest
// yet", because the predicate underneath it read a counter that
// resets when the process does. An empty state that can appear over
// a full cluster is worse than no empty state.

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
