// Copyright OBSESC Authors
//
// Small "N firing" chip for the NodeCard (Lane U1). Renders nothing unless
// this node currently has firing alerts — it shares the firing-count query
// (and its ≥30s cadence) with the Header badge via useFiringAlertCount.
// Alerts are served by THIS node's /obsesc-api, so the chip only belongs on
// the local node's card, not on peer-membership cards.

import { ReactElement } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Chip } from '@mui/material';
import { AlertsRoute } from '../../model/route';
import { useFiringAlertCount } from './use-alerts';

export function FiringAlertsChip(): ReactElement | null {
  const firing = useFiringAlertCount();
  if (firing === null || firing === 0) return null;
  return (
    <Chip
      size="small"
      color="error"
      clickable
      component={RouterLink}
      to={`${AlertsRoute}?status=firing`}
      label={`${firing} firing`}
    />
  );
}
