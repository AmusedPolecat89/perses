// Copyright OBSESC Authors
//
// NodeManager view — the operator's fleet surface. Today renders a
// single node fed by /v1/health + /metrics; tomorrow renders the
// `/v1/cluster` response when the cluster control plane lands.
//
// Preview-mode caveats are surfaced inline so the operator knows
// what's stubbed (e.g. "Add node" is disabled until v0.3, instance
// type is hardcoded until obsesc_node_info ships).

import { ReactElement, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
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

interface NodeRow {
  name: string;
  instanceId: string;
}

const NODES: NodeRow[] = [
  // Single-node deployment is the default product shape. The array
  // form is on purpose so adding a second node is a data-only change
  // once the cluster control plane lands.
  { name: 'phase-a-local', instanceId: DEFAULT_INSTANCE_ID },
];

export default function NodeManagerView(): ReactElement {
  const { data: stats, isLoading, error } = useNodeStats(5_000);
  const [resizeTarget, setResizeTarget] = useState<NodeRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <Box sx={{ padding: 3, maxWidth: 1280, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-end" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
            Cluster
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {NODES.length === 1
              ? 'Single-node deployment. Resize this node to handle more load, or add a second node for horizontal scale.'
              : `${NODES.length} nodes. Each node owns a slice of services; ingest and queries fan out automatically.`}
          </Typography>
        </Box>
        <Button variant="contained" onClick={() => setAddOpen(true)}>
          + Add node
        </Button>
      </Stack>

      <Stack
        direction="row"
        flexWrap="wrap"
        gap={2}
        sx={{ mt: 2 }}
      >
        {NODES.map((node) => (
          <NodeCard
            key={node.name}
            name={node.name}
            instanceId={node.instanceId}
            stats={stats}
            isLoading={isLoading}
            error={error}
            onResize={() => setResizeTarget(node)}
          />
        ))}
      </Stack>

      {NODES.length === 1 && (
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
        currentInstanceId={resizeTarget?.instanceId ?? DEFAULT_INSTANCE_ID}
      />
      <AddNodeDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </Box>
  );
}
