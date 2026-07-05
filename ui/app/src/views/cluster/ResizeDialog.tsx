// Copyright OBSESC Authors
//
// Resize = guided blue/green stepper (Phase 4). There is no hidden saga:
// each step is an explicit operator click composing the cluster primitives
//   1. launch a replacement of the target type   (POST /v1/cluster/nodes)
//   2. drain the old node                        (POST …/drain + live poll)
//   3. remove + terminate the old node           (DELETE …?terminate=)
// The cost narrative is honest: step 1 shows the TRANSIENT double-cost from
// the server's preview, plus the approximate final delta once the old node
// is gone. Closing the dialog cancels nothing — the membership table keeps
// showing reality and every step can be finished from the per-node actions.

import { ReactElement, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Step,
  StepContent,
  StepLabel,
  Stepper,
  Typography,
} from '@mui/material';
import { findInstance, INSTANCE_TYPES, InstanceSpec, monthlyUsd } from './instance-types';
import {
  ClusterConflictError,
  ClusterNode,
  useAddNode,
  useCostPreview,
  useDrainStatus,
  useRemoveNode,
  useStartDrain,
} from './use-cluster';
import { CostPreviewBox } from './CostPreviewBox';
import { DrainProgress } from './DrainProgress';
import { usdDeltaPretty } from './format';

/**
 * Mid-flow memory, keyed by the OLD node's id. Module-scoped (same pattern
 * as use-node-stats' prevCommitted) so closing and reopening the dialog
 * resumes from the recorded flow state instead of re-offering a live
 * "Launch replacement" button — the double-launch/double-cost footgun.
 * The baseline snapshot also lets a MANUALLY launched replacement
 * (provision=false) advance the stepper: any member that wasn't in the
 * ring when the flow first opened counts as the replacement having joined.
 * Cleared when the flow completes (old node removed).
 */
interface ResizeFlow {
  /** Member ids when this flow first opened. */
  baselineIds: string[];
  launched: { instanceId: string; nodesAtLaunch: number } | null;
}
const resizeFlows = new Map<string, ResizeFlow>();

function getResizeFlow(nodeId: string, nodes: ClusterNode[]): ResizeFlow {
  const existing = resizeFlows.get(nodeId);
  if (existing) return existing;
  const created: ResizeFlow = { baselineIds: nodes.map((n) => n.id), launched: null };
  // Don't persist a baseline off an empty/still-loading membership snapshot —
  // it would make every later member look like "the replacement joined".
  if (nodes.length > 0) resizeFlows.set(nodeId, created);
  return created;
}

interface ResizeDialogProps {
  open: boolean;
  onClose: () => void;
  /** The node being replaced. */
  node: ClusterNode;
  /** Live membership — used to detect the replacement's self-join. */
  nodes: ClusterNode[];
  /**
   * The old node's instance type from obsesc_node_info, or null when the
   * metric is absent (older node) — the final-delta estimate then says so.
   */
  currentInstanceType: string | null;
  /** EC2 launch/terminate wired on this deployment. */
  provision: boolean;
  /** Bubbles the 202 up so the view shows the launching row + fast-polls. */
  onLaunched: (instanceId: string, instanceType: string) => void;
}

export function ResizeDialog({
  open,
  onClose,
  node,
  nodes,
  currentInstanceType,
  provision,
  onLaunched,
}: ResizeDialogProps): ReactElement {
  const [targetType, setTargetType] = useState<string>('c7i.4xlarge');
  // Restore any mid-flow state recorded for this node (close/reopen safe).
  const flow = getResizeFlow(node.id, nodes);
  const [launched, setLaunchedState] = useState<ResizeFlow['launched']>(flow.launched);
  const setLaunched = (l: ResizeFlow['launched']): void => {
    flow.launched = l;
    setLaunchedState(l);
  };

  const oldSpec: InstanceSpec | undefined = currentInstanceType ? findInstance(currentInstanceType) : undefined;
  const newSpec = findInstance(targetType);

  const launch = useAddNode();
  const startDrain = useStartDrain();
  const remove = useRemoveNode();

  // Step 1 completes from OBSERVABLE state, not just the launch mutation:
  //  - the launched instance id shows up as a member (contract assumption:
  //    node id == EC2 instance id), or membership grew since the launch;
  //  - a member appears that wasn't in the ring when this flow opened —
  //    the manually-launched replacement path (provision=false);
  //  - the old node is already draining/removed (later steps ran), which
  //    also makes a reopened dialog resume at the right step.
  const launchJoined =
    launched !== null && (nodes.some((n) => n.id === launched.instanceId) || nodes.length > launched.nodesAtLaunch);
  const manualJoined = nodes.some((n) => n.id !== node.id && !flow.baselineIds.includes(n.id));
  const drainStarted = node.status === 'draining' || startDrain.isSuccess;
  const removed = remove.isSuccess;
  const joined = launchJoined || manualJoined || drainStarted || removed;

  const preview = useCostPreview({ action: 'add', instance_type: targetType }, open && launched === null && !joined);
  // The step only advances past "drain" when the SERVER says drained.
  const drainQuery = useDrainStatus(node.id, open && drainStarted && !removed);
  const drained = drainQuery.data?.status === 'drained';
  let activeStep = 3;
  if (!joined) activeStep = 0;
  else if (!drained) activeStep = 1;
  else if (!removed) activeStep = 2;

  // Approximate FINAL delta (old gone, new in): static price table, labeled.
  const finalDelta = oldSpec && newSpec ? monthlyUsd(newSpec) - monthlyUsd(oldSpec) : undefined;

  const close = (): void => {
    launch.reset();
    startDrain.reset();
    remove.reset();
    onClose();
  };

  const conflictAlert = (err: unknown, copy: string): ReactElement | null => {
    if (err instanceof ClusterConflictError) {
      return (
        <Alert severity="info" variant="outlined">
          {copy} {err.message}
        </Alert>
      );
    }
    if (err instanceof Error) {
      return (
        <Alert severity="error" variant="outlined">
          {err.message}
        </Alert>
      );
    }
    return null;
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Resize {node.id} — blue/green replacement</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Three explicit steps, no hidden automation: launch the replacement, drain the old node (no data loss — it
          flushes everything first), then remove it. You can stop after any step; the member list always shows the true
          state.
        </Typography>

        <Stepper activeStep={activeStep} orientation="vertical">
          {/* ── Step 1: launch replacement ─────────────────────────────── */}
          <Step completed={joined}>
            <StepLabel>Launch replacement node</StepLabel>
            <StepContent>
              <Stack gap={1.5}>
                <Stack direction="row" gap={1} flexWrap="wrap">
                  {INSTANCE_TYPES.map((spec) => (
                    <Chip
                      key={spec.id}
                      label={`${spec.id} · ${spec.vcpu} vCPU / ${spec.memoryGb} GB`}
                      color={spec.id === targetType ? 'primary' : 'default'}
                      variant={spec.id === targetType ? 'filled' : 'outlined'}
                      onClick={() => setTargetType(spec.id)}
                      disabled={launched !== null}
                    />
                  ))}
                </Stack>

                <CostPreviewBox
                  preview={preview.data}
                  isLoading={preview.isLoading && preview.fetchStatus !== 'idle'}
                  error={launched === null ? preview.error : null}
                />
                <Typography variant="caption" color="text.secondary">
                  That delta is the <strong>transient double-cost</strong> — old and new run side by side until step 3.
                  Net change once {node.id} is removed:{' '}
                  {finalDelta !== undefined ? (
                    <strong>{usdDeltaPretty(finalDelta)}</strong>
                  ) : (
                    'unknown (the old node doesn’t report its instance type)'
                  )}{' '}
                  — approx, static price table
                  {currentInstanceType === null ? ', current size estimated' : ''}.
                </Typography>

                {launch.isLoading && (
                  <Stack direction="row" alignItems="center" gap={1}>
                    <CircularProgress size={16} />
                    <Typography variant="body2">Requesting launch…</Typography>
                  </Stack>
                )}
                {conflictAlert(
                  launch.error,
                  'Provisioning is disabled on this deployment — launch the replacement yourself from the AMI and it will self-join.'
                )}
                {launched !== null && !joined && (
                  <Typography variant="body2" color="text.secondary">
                    Launch accepted ({launched.instanceId}) — waiting for the node to self-join the manifest (typically
                    1–3 min)…
                  </Typography>
                )}

                {launched === null && (
                  <Box>
                    <Button
                      variant="contained"
                      disabled={launch.isLoading || !provision}
                      onClick={() =>
                        launch.mutate(
                          { instance_type: targetType, role: node.role },
                          {
                            onSuccess: (accepted) => {
                              setLaunched({
                                instanceId: accepted.instance_id,
                                nodesAtLaunch: nodes.length,
                              });
                              onLaunched(accepted.instance_id, targetType);
                            },
                          }
                        )
                      }
                    >
                      Launch replacement
                    </Button>
                    {!provision && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        Provisioning disabled — launch the instance from the AMI yourself; this stepper picks up at step
                        2 once it joins.
                      </Typography>
                    )}
                  </Box>
                )}
              </Stack>
            </StepContent>
          </Step>

          {/* ── Step 2: drain the old node ─────────────────────────────── */}
          <Step completed={activeStep > 1}>
            <StepLabel>Drain {node.id}</StepLabel>
            <StepContent>
              <Stack gap={1.5}>
                <Typography variant="body2" color="text.secondary">
                  Routes ingest to the replacement and flushes {node.id}&apos;s open buckets + WAL. Nothing is removed
                  yet.
                </Typography>
                {conflictAlert(startDrain.error, 'The cluster refused the drain:')}
                {!drainStarted ? (
                  <Box>
                    <Button
                      variant="contained"
                      disabled={startDrain.isLoading}
                      onClick={() => startDrain.mutate({ nodeId: node.id })}
                    >
                      Start drain
                    </Button>
                  </Box>
                ) : (
                  <DrainProgress nodeId={node.id} enabled={open && drainStarted && !removed} />
                )}
              </Stack>
            </StepContent>
          </Step>

          {/* ── Step 3: remove + terminate the old node ─────────────────── */}
          <Step completed={removed}>
            <StepLabel>Remove {node.id}</StepLabel>
            <StepContent>
              <Stack gap={1.5}>
                <Alert severity="success" variant="outlined">
                  {node.id} is drained — open buckets and WAL backlog are at zero.
                </Alert>
                <Typography variant="body2" color="text.secondary">
                  Removes the drained node from the manifest
                  {provision
                    ? ' and terminates its EC2 instance — billing for the old size stops here.'
                    : '. Provisioning is disabled, so stop/terminate the old instance yourself afterwards.'}
                </Typography>
                {conflictAlert(remove.error, 'The cluster refused the removal:')}
                {!removed ? (
                  <Box>
                    <Button
                      variant="contained"
                      color="error"
                      disabled={remove.isLoading}
                      onClick={() =>
                        remove.mutate(
                          { nodeId: node.id, terminate: provision, force: false },
                          // Flow complete — forget the mid-flow memory so a
                          // future resize of a same-named node starts fresh.
                          { onSuccess: () => resizeFlows.delete(node.id) }
                        )
                      }
                    >
                      Remove{provision ? ' + terminate' : ''} {node.id}
                    </Button>
                  </Box>
                ) : null}
              </Stack>
            </StepContent>
          </Step>
        </Stepper>

        {removed && remove.data && (
          <Alert severity="success" variant="outlined" sx={{ mt: 2 }}>
            Resize complete — {remove.data.removed} removed at epoch {remove.data.epoch}
            {remove.data.terminated ? ' and its instance terminated.' : ' (instance left running).'}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} color="inherit">
          {removed ? 'Close' : 'Cancel'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export type { InstanceSpec };
