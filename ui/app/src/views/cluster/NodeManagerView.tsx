// Copyright OBSESC Authors
//
// NodeManager view — the operator's fleet surface. Members come live from
// `GET /v1/cluster` (epoch, routing mode, active ring members); per-node
// stats come from this node's /v1/health + /metrics. When the endpoint is
// unreachable or clustering is disabled, falls back to a single local card.
//
// Preview-mode caveats are surfaced inline so the operator knows what's
// stubbed (e.g. "Add node" is disabled until v0.3, instance type is
// hardcoded until obsesc_node_info ships).

import { ReactElement, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Box, Button, Chip, Stack, Tooltip, Typography } from '@mui/material';
import { useNodeStats } from './use-node-stats';
import { NodeCard } from './NodeCard';
import { ResizeDialog } from './ResizeDialog';
import { AddNodeDialog } from './AddNodeDialog';
import { ProjectSettings } from './ProjectSettings';

// TODO(β.3.5): once obsesc_node_info{instance_type="…"} is exposed by
// obsesc-node at boot (pulled from EC2 metadata), read this from
// useNodeStats() instead of hardcoding. Today's value matches the
// brief's c7i.2xlarge target.
const DEFAULT_INSTANCE_ID = 'c7i.2xlarge';

interface ClusterView {
  enabled: boolean;
  epoch: number;
  this_node: string | null;
  routing: 'owner' | 'arrival';
  nodes: Array<{ id: string; addr: string }>;
}

function useClusterView() {
  return useQuery<ClusterView | null>({
    queryKey: ['obsesc-cluster-view'],
    refetchInterval: 10_000,
    queryFn: async () => {
      const res = await fetch('/obsesc-api/v1/cluster');
      if (!res.ok) return null; // older node / endpoint absent → fallback
      return (await res.json()) as ClusterView;
    },
    retry: false,
  });
}

const ROUTING_COPY: Record<ClusterView['routing'], string> = {
  arrival:
    'Shard-by-arrival: every node keeps what it receives — no forwarding hop. Queries fan out cluster-wide, so any node answers with complete results. Adding a node is instant capacity.',
  owner:
    'Owner routing: each node owns a slice of services (rendezvous hashing); ingest forwards to the owner and queries prune to it.',
};

export default function NodeManagerView(): ReactElement {
  const { data: stats, isLoading, error } = useNodeStats(5_000);
  const { data: cluster } = useClusterView();
  const [resizeTarget, setResizeTarget] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Live membership when available; single local card otherwise.
  const members: Array<{ id: string; addr?: string }> =
    cluster?.enabled && cluster.nodes.length > 0
      ? cluster.nodes
      : [{ id: 'this node' }];
  const routing = cluster?.routing ?? 'owner';
  const multi = members.length > 1;

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
            {!multi
              ? 'Single-node deployment. Resize this node to handle more load, or add a second node for horizontal scale.'
              : `${members.length} active members. ${
                  routing === 'arrival'
                    ? 'Every node ingests what it receives; queries fan out cluster-wide.'
                    : 'Each node owns a slice of services; ingest and queries route to owners.'
                }`}
          </Typography>
        </Box>
        <Button variant="contained" onClick={() => setAddOpen(true)}>
          + Add node
        </Button>
      </Stack>

      <Stack direction="row" flexWrap="wrap" gap={2} sx={{ mt: 2 }}>
        {members.map((node) => {
          const isThisNode = !multi || node.id === cluster?.this_node;
          return (
            <NodeCard
              key={node.id}
              name={
                node.id === cluster?.this_node ? `${node.id} (this node)` : node.id
              }
              instanceId={DEFAULT_INSTANCE_ID}
              // Live stats come from THIS node's /metrics; peers show
              // membership + address until per-peer scrape lands.
              stats={isThisNode ? stats : undefined}
              isLoading={isThisNode ? isLoading : false}
              error={isThisNode ? error : null}
              peerAddr={!isThisNode ? node.addr : undefined}
              onResize={() => setResizeTarget(node.id)}
            />
          );
        })}
      </Stack>

      {!multi && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3 }}>
          Preview view — live stats are real, but the resize and add-node actions are
          UI scaffolds until the cluster control plane lands. Confirming a resize will
          show the cost delta but not yet provision the new instance.
        </Typography>
      )}

      <ProjectSettings />

      <ResizeDialog
        open={resizeTarget !== null}
        onClose={() => setResizeTarget(null)}
        currentInstanceId={DEFAULT_INSTANCE_ID}
      />
      <AddNodeDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </Box>
  );
}
