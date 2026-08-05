// Copyright OBSESC Authors
//
// Add-node dialog — live (Phase 4). One dialog, no AWS console hand-off:
// pick an instance type + role, see the honest cost delta BEFORE
// committing, confirm → POST /v1/cluster/nodes (202). The parent then
// shows an optimistic "launching…" row and polls /v1/cluster until the
// node self-joins (epoch advances, member appears).

import { ReactElement, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { AsyncOpBar, AsyncOpStatus } from '../../components/progress/AsyncOp';
import { useTrackedOp } from '../../components/progress/useAsyncOp';
import { INSTANCE_TYPES, findInstance } from './instance-types';
import { ClusterConflictError, useAddNode, useCostPreview } from './use-cluster';
import { CostPreviewBox } from './CostPreviewBox';

/** node.role wire values (obsesc-config: ingest | query | all). */
const NODE_ROLES = [
  { id: 'all', label: 'all — ingest + query (default)' },
  { id: 'ingest', label: 'ingest — accepts writes only' },
  { id: 'query', label: 'query — serves reads only' },
] as const;

interface AddNodeDialogProps {
  open: boolean;
  onClose: () => void;
  /** 202 accepted → the parent renders the optimistic launching row. */
  onLaunched: (instanceId: string, instanceType: string) => void;
}

export function AddNodeDialog({ open, onClose, onLaunched }: AddNodeDialogProps): ReactElement {
  const [instanceType, setInstanceType] = useState('c7i.2xlarge');
  const [role, setRole] = useState<string>('all');
  const selected = findInstance(instanceType);

  const preview = useCostPreview({ action: 'add', instance_type: instanceType }, open);
  const launch = useAddNode();
  const launchOp = useTrackedOp(launch.isLoading, {
    receipt: launch.data ? `instance ${launch.data.instance_id} starting` : null,
  });

  const close = (): void => {
    launch.reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Add a node — horizontal scale</DialogTitle>
      <DialogContent>
        <Stack gap={2}>
          <Typography variant="body2" color="text.secondary">
            Launches an EC2 in this deployment&apos;s VPC from the baked AMI. The new node self-joins the cluster
            manifest and starts taking its slice of traffic — no AWS console steps.
          </Typography>

          <Box>
            <Typography variant="overline" color="text.secondary">
              Instance type
            </Typography>
            <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>
              {INSTANCE_TYPES.map((spec) => (
                <Chip
                  key={spec.id}
                  label={`${spec.id} · ${spec.vcpu} vCPU / ${spec.memoryGb} GB`}
                  color={spec.id === instanceType ? 'primary' : 'default'}
                  variant={spec.id === instanceType ? 'filled' : 'outlined'}
                  onClick={() => setInstanceType(spec.id)}
                />
              ))}
            </Stack>
            {selected && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {selected.recommendedFor}
              </Typography>
            )}
          </Box>

          <TextField
            select
            size="small"
            label="Node role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            sx={{ maxWidth: 360 }}
          >
            {NODE_ROLES.map((r) => (
              <MenuItem key={r.id} value={r.id}>
                {r.label}
              </MenuItem>
            ))}
          </TextField>

          <Divider />

          <CostPreviewBox
            preview={preview.data}
            isLoading={preview.isLoading && preview.fetchStatus !== 'idle'}
            error={preview.error}
          />

          {/* A WRITE: elapsed + a receipt, and no Cancel — aborting the
              fetch would not un-launch an instance. */}
          <AsyncOpBar state={launchOp} testId="asyncop-bar-launch" />
          <AsyncOpStatus
            id="cluster-launch"
            state={launchOp}
            label="Launch"
            runningHint="Requesting launch…"
          />
          {launch.error instanceof ClusterConflictError && (
            <Alert severity="info" variant="outlined">
              <strong>Provisioning is disabled on this deployment.</strong> The node has no EC2 launch permissions (IAM
              role / launch template not configured). Launch the instance yourself from the AMI and it will self-join;
              or enable provisioning in config.yaml.
            </Alert>
          )}
          {launch.error && !(launch.error instanceof ClusterConflictError) && (
            <Alert severity="error" variant="outlined">
              Launch failed: {launch.error.message}
            </Alert>
          )}
          {launch.data && (
            <Alert severity="success" variant="outlined">
              Launch accepted — instance <strong>{launch.data.instance_id}</strong> is starting. It appears in the
              member list once it self-joins (typically 1–3 min: EC2 boot + manifest CAS).
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} color="inherit">
          {launch.data ? 'Close' : 'Cancel'}
        </Button>
        {!launch.data && (
          <Button
            variant="contained"
            disabled={launch.isLoading || !instanceType}
            onClick={() =>
              launch.mutate(
                { instance_type: instanceType, role },
                { onSuccess: (accepted) => onLaunched(accepted.instance_id, instanceType) }
              )
            }
          >
            Launch node
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
