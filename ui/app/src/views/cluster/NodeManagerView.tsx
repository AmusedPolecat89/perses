// Copyright OBSESC Authors
//
// NodeManager view — the operator's fleet surface, live (Phase 4).
// Membership (id/addr/role/status), epoch and routing come from
// `GET /v1/cluster`; per-node stats from this node's /v1/health + /metrics
// (including obsesc_node_info for the real instance type). Lifecycle
// actions (add / drain+remove / blue-green resize) gate tri-state on
// useCapabilities().cluster:
//   - cluster disabled (or unknown)      → read-only presentation, no actions
//   - enabled but provision=false        → drain/remove live; Add/Resize
//                                          launches blocked ("provisioning
//                                          disabled" tooltip)
//   - enabled + provision                → everything live
// Frictionless ops: every action is one dialog with an honest cost preview
// before commit — no AWS console hand-offs.

import { ReactElement, useEffect, useMemo, useState } from 'react';
import { Box, Button, Chip, Stack, Tooltip, Typography } from '@mui/material';
import { useCapabilities } from '../../hooks/use-capabilities';
import { useNodeStats } from './use-node-stats';
import { NodeCard } from './NodeCard';
import { ResizeDialog } from './ResizeDialog';
import { AddNodeDialog } from './AddNodeDialog';
import { ProjectSettings } from './ProjectSettings';
import { FingerprintEpochCard } from './FingerprintEpochCard';
import { ClusterMembersCard, PendingLaunch } from './ClusterMembersCard';
import { RemoveNodeDialog } from './RemoveNodeDialog';
import { ActivityFeedCard } from './ActivityFeedCard';
import { ClusterNode, useClusterView } from './use-cluster';

// Fallback when /metrics doesn't carry obsesc_node_info (older node) —
// every surface that uses it labels the value "estimated".
const DEFAULT_INSTANCE_ID = 'c7i.2xlarge';

const ROUTING_COPY: Record<'owner' | 'arrival', string> = {
  arrival:
    'Shard-by-arrival: every node keeps what it receives — no forwarding hop. Queries fan out cluster-wide, so any node answers with complete results. Adding a node is instant capacity.',
  owner:
    'Owner routing: each node owns a slice of services (rendezvous hashing); ingest forwards to the owner and queries prune to it.',
};

export default function NodeManagerView(): ReactElement {
  const caps = useCapabilities();
  const { data: stats, isLoading, error } = useNodeStats(5_000);
  const [pendingLaunch, setPendingLaunch] = useState<PendingLaunch | null>(null);
  const [nodesAtLaunch, setNodesAtLaunch] = useState(0);
  // Poll membership fast while a launch is in flight so the self-join
  // (epoch advance + new member) shows up promptly.
  const { data: cluster } = useClusterView(pendingLaunch ? 3_000 : 10_000);
  const [resizeTargetId, setResizeTargetId] = useState<string | null>(null);
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Tri-state capability gate (standard #4): actions only render once the
  // capability is CONFIRMED — loading/unreachable are read-only, not "off".
  const clusterCap = caps.cluster;
  const actionsEnabled = !caps.isLoading && !caps.unavailable && clusterCap.enabled;
  const provision = actionsEnabled && clusterCap.provision;

  // Clear the optimistic launching row once the node self-joins — by id
  // (contract assumption: member id == EC2 instance id) or, failing that,
  // when membership simply grew past its at-launch size.
  const nodes = useMemo(() => cluster?.nodes ?? [], [cluster]);
  useEffect(() => {
    if (pendingLaunch && (nodes.some((n) => n.id === pendingLaunch.instanceId) || nodes.length > nodesAtLaunch)) {
      setPendingLaunch(null);
    }
  }, [pendingLaunch, nodes, nodesAtLaunch]);

  const onLaunched = (instanceId: string, instanceType: string): void => {
    setNodesAtLaunch(nodes.length);
    setPendingLaunch({ instanceId, instanceType });
  };

  const clusterLive = cluster?.enabled === true && nodes.length > 0;
  const routing = cluster?.routing ?? 'owner';
  const thisNodeId = cluster?.this_node ?? null;
  const instanceType = stats?.instanceType ?? null;

  // Dialog targets resolve LIVE against the current membership so status
  // transitions (draining → drained → gone) flow into the open dialog.
  const resizeTarget: ClusterNode | null =
    nodes.find((n) => n.id === resizeTargetId) ??
    (resizeTargetId !== null
      ? // Fallback when /v1/cluster is absent: a synthetic single-node member.
        { id: resizeTargetId, addr: '', role: stats?.nodeRole ?? 'all', status: 'active' }
      : null);
  const removeTarget: ClusterNode | null = nodes.find((n) => n.id === removeTargetId) ?? null;

  return (
    <Box sx={{ padding: 3, maxWidth: 1280, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-end" sx={{ mb: 2 }}>
        <Box>
          <Stack direction="row" alignItems="center" gap={1.5}>
            <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
              Cluster
            </Typography>
            {cluster?.enabled && (
              <>
                <Tooltip title={ROUTING_COPY[routing]}>
                  <Chip
                    size="small"
                    color={routing === 'arrival' ? 'success' : 'default'}
                    label={`routing: ${routing}`}
                  />
                </Tooltip>
                <Chip size="small" variant="outlined" label={`epoch ${cluster.epoch}`} />
              </>
            )}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {!clusterLive
              ? 'Single-node deployment. Resize this node to handle more load, or add a second node for horizontal scale.'
              : `${nodes.length} member${nodes.length === 1 ? '' : 's'}. ${
                  routing === 'arrival'
                    ? 'Every node ingests what it receives; queries fan out cluster-wide.'
                    : 'Each node owns a slice of services; ingest and queries route to owners.'
                }`}
          </Typography>
        </Box>
        {actionsEnabled &&
          (provision ? (
            <Button variant="contained" onClick={() => setAddOpen(true)}>
              + Add node
            </Button>
          ) : (
            <Tooltip title="Provisioning disabled — this deployment has no EC2 launch permissions (IAM role / launch template). Launch instances from the AMI yourself; they self-join.">
              <span>
                <Button variant="contained" disabled>
                  + Add node
                </Button>
              </span>
            </Tooltip>
          ))}
      </Stack>

      {/* Live membership: every manifest node with role + status. */}
      {clusterLive && cluster && (
        <ClusterMembersCard
          cluster={cluster}
          pendingLaunch={pendingLaunch}
          actionsEnabled={actionsEnabled}
          onResize={(node) => setResizeTargetId(node.id)}
          onRemove={(node) => setRemoveTargetId(node.id)}
        />
      )}

      {/* This node's live gauges (peers are reached via their own UIs). */}
      <Stack direction="row" flexWrap="wrap" gap={2} sx={{ mt: 2 }}>
        <NodeCard
          name={thisNodeId ? `${thisNodeId} (this node)` : 'this node'}
          instanceId={instanceType ?? DEFAULT_INSTANCE_ID}
          instanceEstimated={instanceType === null}
          stats={stats}
          isLoading={isLoading}
          error={error}
          onResize={actionsEnabled ? (): void => setResizeTargetId(thisNodeId ?? 'this node') : undefined}
        />
      </Stack>

      {!caps.isLoading && caps.unavailable && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3 }}>
          Node unreachable — membership and lifecycle actions will load once the node answers.
        </Typography>
      )}
      {!caps.isLoading && !caps.unavailable && !clusterCap.enabled && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3 }}>
          Read-only view — the cluster control plane isn&apos;t enabled on this node (cluster.enabled in config.yaml).
          Live stats are real; add/resize/remove unlock when clustering is on.
        </Typography>
      )}

      {/* Operator audit trail (launch / drain / remove / terminate). */}
      <ActivityFeedCard enabled={actionsEnabled} />

      {/* Lane U4: epoch admin — self-gates (tri-state) on useCapabilities(). */}
      <FingerprintEpochCard />

      <ProjectSettings />

      {resizeTarget && (
        <ResizeDialog
          open
          onClose={() => setResizeTargetId(null)}
          node={resizeTarget}
          nodes={nodes}
          currentInstanceType={resizeTarget.id === thisNodeId || !clusterLive ? instanceType : null}
          provision={provision}
          onLaunched={onLaunched}
        />
      )}
      {removeTarget && (
        <RemoveNodeDialog open onClose={() => setRemoveTargetId(null)} node={removeTarget} provision={provision} />
      )}
      <AddNodeDialog open={addOpen} onClose={() => setAddOpen(false)} onLaunched={onLaunched} />
    </Box>
  );
}
