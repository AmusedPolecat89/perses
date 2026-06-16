// Copyright OBSESC Authors
//
// Horizontal scale confirm dialog — UI scaffold only.
// Cluster membership / hash ring / migration protocol all land in a
// separate backend chunk (v0.3). Disabled with a tooltip so operators
// know the surface exists but isn't live.

import { ReactElement } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';

interface AddNodeDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AddNodeDialog({ open, onClose }: AddNodeDialogProps): ReactElement {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add a node — horizontal scale</DialogTitle>
      <DialogContent>
        <Stack gap={2}>
          <Typography variant="body2" color="text.secondary">
            Adds a second EC2 to the cluster. Services rebalance across nodes via a
            consistent-hash ring; new node picks up its slice of baselines from the
            shared object store on the next bucket flush.
          </Typography>
          <Box
            sx={{
              p: 1.5,
              borderRadius: 1,
              backgroundColor: 'rgba(245, 158, 11, 0.12)',
            }}
          >
            <Typography variant="body2">
              <strong>Coming in v0.3.</strong> For now most workloads scale better by
              upgrading the single node (vertical). Operators with sustained &gt;400k
              ev/s or HA needs will land here later.
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary">
            Backend prerequisites: cluster membership manifest, rendezvous-hash ring,
            service-migration protocol, AWS EC2-launch caller, IAM role with launch
            permissions in the AMI's VPC.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Close
        </Button>
        <Tooltip title="Pending cluster control plane — backend caller lands in v0.3">
          <span>
            <Button variant="contained" disabled>
              Add node
            </Button>
          </span>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
}
