// Copyright OBSESC Authors
//
// Header nav entry for /alerts (Lane U1). Lives here — not in Header.tsx —
// per hot-file discipline: Header gets one import + one call-site, the
// badge logic stays in the lane's directory.
//
// The badge shows the firing count and is hidden when it's 0, when
// alerting is disabled, or when the node is unreachable (the count query
// itself is gated inside useFiringAlertCount). The button always renders:
// the route owns the honest disabled/unreachable states.

import { ReactElement } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Badge, Box, Button } from '@mui/material';
import BellOutline from 'mdi-material-ui/BellOutline';
import { AlertsRoute } from '../../model/route';
import { useFiringAlertCount } from './use-alerts';

export function AlertsNavButton(): ReactElement {
  const firing = useFiringAlertCount();
  return (
    <Button
      aria-label="Alerts"
      color="inherit"
      component={RouterLink}
      to={AlertsRoute}
      sx={{ marginLeft: 0.5 }}
    >
      <Badge
        color="error"
        badgeContent={firing ?? 0}
        invisible={firing === null || firing === 0}
        max={999}
        sx={{ marginRight: 0.5 }}
      >
        <BellOutline fontSize="small" />
      </Badge>
      <Box sx={{ marginLeft: 0.5 }}>Alerts</Box>
    </Button>
  );
}
