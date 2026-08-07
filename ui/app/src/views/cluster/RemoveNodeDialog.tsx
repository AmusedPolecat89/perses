// Copyright OBSESC Authors
//
// Remove-node flow: cost preview → drain (live progress, real numbers) →
// remove (optionally terminating the EC2). "Remove" stays locked until the
// server reports the node drained — force is only surfaced when the node is
// down (nothing left to drain, buffered data unconfirmable). The view never
// opens this dialog for the last active node.

import { ReactElement, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Stack,
  Typography,
} from '@mui/material';
import { AsyncOpBar, AsyncOpStatus } from '../../components/progress/AsyncOp';
import { useTrackedOp } from '../../components/progress/useAsyncOp';
import {
  ClusterConflictError,
  ClusterNode,
  useCostPreview,
  useDrainStatus,
  useRemoveNode,
  useStartDrain,
} from './use-cluster';
import { CostPreviewBox } from './CostPreviewBox';
import { DrainProgress } from './DrainProgress';

interface RemoveNodeDialogProps {
  open: boolean;
  onClose: () => void;
  node: ClusterNode;
  /** EC2 terminate offered only when the control plane can provision. */
  provision: boolean;
}

export function RemoveNodeDialog({ open, onClose, node, provision }: RemoveNodeDialogProps): ReactElement {
  const [terminate, setTerminate] = useState(true);
  const [forceAck, setForceAck] = useState(false);

  const preview = useCostPreview({ action: 'remove', node_id: node.id }, open);
  const startDrain = useStartDrain();
  const startDrainOp = useTrackedOp(startDrain.isLoading);
  // Track the drain whenever the node is mid-lifecycle (not before the
  // operator acts, and not once the node is removed or down).
  const remove = useRemoveNode();
  const removeOp = useTrackedOp(remove.isLoading, {
    receipt: remove.data ? `removed at epoch ${remove.data.epoch}` : null,
  });
  const drainVisible =
    open && !remove.isSuccess && (node.status === 'draining' || startDrain.isSuccess || node.status === 'down');
  const drain = useDrainStatus(node.id, drainVisible && node.status !== 'down');

  const isDown = node.status === 'down';
  const drained = drain.data?.status === 'drained';
  const draining = node.status === 'draining' || startDrain.isSuccess;
  const canRemove = drained || (isDown && forceAck);

  const close = (): void => {
    startDrain.reset();
    remove.reset();
    setForceAck(false);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Remove node {node.id}</DialogTitle>
      <DialogContent>
        <Stack gap={2}>
          <Typography variant="body2" color="text.secondary">
            Removing a node first <strong>drains</strong> it: ingest routes away and it flushes open buckets + WAL to
            the object store, so nothing is lost. Only a drained node can be removed
            {isDown ? ' — unless it is down and you force it' : ''}.
          </Typography>

          <CostPreviewBox
            preview={preview.data}
            isLoading={preview.isLoading && preview.fetchStatus !== 'idle'}
            error={preview.error}
          />

          <Divider />

          {/* Step 1: drain (skipped for a down node — nothing answers). */}
          {!isDown && !draining && (
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
              <Typography variant="body2">
                Step 1 — drain the node (keeps ingesting nothing new, flushes what it holds).
              </Typography>
              <Button
                variant="outlined"
                disabled={startDrain.isLoading}
                onClick={() => startDrain.mutate({ nodeId: node.id })}
              >
                Start drain
              </Button>
            </Stack>
          )}
          {/* WRITES: elapsed + a receipt, never a Cancel — aborting the
              fetch does not un-drain or un-remove a node. */}
          <AsyncOpBar state={startDrainOp} testId="asyncop-bar-drain" />
          <AsyncOpStatus
            id="cluster-drain"
            state={startDrainOp}
            label="Drain"
            runningHint="Starting drain…"
          />
          {startDrain.error instanceof ClusterConflictError && (
            <Alert severity="info" variant="outlined">
              This is the last active node — the cluster refused to drain it. Add a node first, then retire this one.
            </Alert>
          )}
          {startDrain.error && !(startDrain.error instanceof ClusterConflictError) && (
            <Alert severity="error" variant="outlined">
              Drain failed to start: {startDrain.error.message}
            </Alert>
          )}
          {draining && !isDown && !remove.data && <DrainProgress nodeId={node.id} enabled={drainVisible} />}

          {isDown && (
            <>
              <Alert severity="error" variant="outlined">
                This node is <strong>down</strong> — it can&apos;t drain, and any data it buffered but hadn&apos;t
                flushed can&apos;t be confirmed committed.
              </Alert>
              <FormControlLabel
                control={<Checkbox checked={forceAck} onChange={(e) => setForceAck(e.target.checked)} />}
                label="Force remove — I accept that unflushed data on this node is lost"
              />
            </>
          )}

          {provision && (
            <FormControlLabel
              control={<Checkbox checked={terminate} onChange={(e) => setTerminate(e.target.checked)} />}
              label="Also terminate the EC2 instance (stops billing for it)"
            />
          )}
          {!provision && (
            <Typography variant="caption" color="text.secondary">
              Provisioning is disabled on this deployment, so the EC2 instance is NOT terminated — the node leaves the
              cluster and you stop/terminate the instance yourself.
            </Typography>
          )}

          <AsyncOpBar state={removeOp} testId="asyncop-bar-remove" />
          <AsyncOpStatus
            id="cluster-remove"
            state={removeOp}
            label="Remove"
            runningHint="Removing the node from the manifest…"
          />
          {remove.error instanceof ClusterConflictError && (
            <Alert severity="info" variant="outlined">
              The cluster refused the removal: {remove.error.message || 'node not drained or last member.'}
            </Alert>
          )}
          {remove.error && !(remove.error instanceof ClusterConflictError) && (
            <Alert severity="error" variant="outlined">
              Remove failed: {remove.error.message}
            </Alert>
          )}
          {remove.data && (
            <Alert severity="success" variant="outlined">
              Removed {remove.data.removed} at epoch {remove.data.epoch}
              {remove.data.terminated ? ' and terminated the instance.' : '. Instance left running.'}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} color="inherit" data-testid="remove-node-dismiss-btn">
          {remove.data ? 'Close' : 'Cancel'}
        </Button>
        {!remove.data && (
          <Button
            variant="contained"
            color="error"
            disabled={!canRemove || remove.isLoading}
            onClick={() =>
              remove.mutate({
                nodeId: node.id,
                terminate: provision && terminate,
                force: isDown && forceAck,
              })
            }
          >
            Remove node
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
