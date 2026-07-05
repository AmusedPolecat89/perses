// Copyright OBSESC Authors
//
// Live membership table — every manifest node with id / addr / role /
// status, plus the per-node lifecycle actions (resize, drain+remove).
// A node the operator just launched shows as an optimistic "launching…"
// row until it self-joins the manifest.

import { ReactElement } from 'react';
import {
  Box,
  Button,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { ClusterNode, ClusterNodeStatus, ClusterView } from './use-cluster';
import { DrainProgress } from './DrainProgress';

export interface PendingLaunch {
  instanceId: string;
  instanceType: string;
}

interface ClusterMembersCardProps {
  cluster: ClusterView;
  pendingLaunch: PendingLaunch | null;
  /** Lifecycle actions rendered at all (false = read-only presentation). */
  actionsEnabled: boolean;
  onResize: (node: ClusterNode) => void;
  onRemove: (node: ClusterNode) => void;
}

function statusChip(status: ClusterNodeStatus): ReactElement {
  switch (status) {
    case 'active':
      return <Chip size="small" color="success" label="active" />;
    case 'draining':
      return <Chip size="small" color="warning" label="draining" />;
    case 'down':
      return <Chip size="small" color="error" label="down" />;
  }
}

export function ClusterMembersCard({
  cluster,
  pendingLaunch,
  actionsEnabled,
  onResize,
  onRemove,
}: ClusterMembersCardProps): ReactElement {
  const activeCount = cluster.nodes.filter((n) => n.status === 'active').length;
  // Never offer remove on the last active node — draining it would 409
  // anyway; the UI doesn't dangle an action the cluster must refuse.
  const isLastActive = (node: ClusterNode): boolean => node.status === 'active' && activeCount <= 1;

  const showPending = pendingLaunch !== null && !cluster.nodes.some((n) => n.id === pendingLaunch.instanceId);

  return (
    <Box
      sx={{
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: 'background.border',
        backgroundColor: 'background.paper',
        mt: 2,
        overflowX: 'auto',
      }}
    >
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Node</TableCell>
            <TableCell>Address</TableCell>
            <TableCell>Role</TableCell>
            <TableCell>Status</TableCell>
            {actionsEnabled && <TableCell align="right">Actions</TableCell>}
          </TableRow>
        </TableHead>
        <TableBody>
          {cluster.nodes.map((node) => {
            const thisNode = node.id === cluster.this_node;
            return (
              <TableRow key={node.id}>
                <TableCell>
                  <Stack direction="row" alignItems="center" gap={1}>
                    <Typography variant="body2" sx={{ fontFamily: '"JetBrains Mono", monospace' }}>
                      {node.id}
                    </Typography>
                    {thisNode && <Chip size="small" variant="outlined" label="this node" />}
                  </Stack>
                </TableCell>
                <TableCell>
                  <Typography variant="caption" sx={{ fontFamily: '"JetBrains Mono", monospace' }}>
                    {node.addr || '—'}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Chip size="small" variant="outlined" label={node.role} />
                </TableCell>
                <TableCell>
                  <Stack direction="row" alignItems="center" gap={1}>
                    {statusChip(node.status)}
                    {node.status === 'draining' && <DrainProgress nodeId={node.id} enabled dense />}
                  </Stack>
                </TableCell>
                {actionsEnabled && (
                  <TableCell align="right">
                    <Stack direction="row" gap={1} justifyContent="flex-end">
                      <Button size="small" variant="outlined" onClick={() => onResize(node)}>
                        Resize
                      </Button>
                      {isLastActive(node) ? (
                        <Tooltip title="Last active node — add another node before retiring this one.">
                          <span>
                            <Button size="small" variant="outlined" color="error" disabled>
                              Remove
                            </Button>
                          </span>
                        </Tooltip>
                      ) : (
                        <Button size="small" variant="outlined" color="error" onClick={() => onRemove(node)}>
                          Remove
                        </Button>
                      )}
                    </Stack>
                  </TableCell>
                )}
              </TableRow>
            );
          })}

          {showPending && (
            <TableRow key={pendingLaunch.instanceId}>
              <TableCell>
                <Typography variant="body2" sx={{ fontFamily: '"JetBrains Mono", monospace' }}>
                  {pendingLaunch.instanceId}
                </Typography>
              </TableCell>
              <TableCell>
                <Typography variant="caption" color="text.secondary">
                  {pendingLaunch.instanceType} · joining…
                </Typography>
              </TableCell>
              <TableCell>
                <Typography variant="caption" color="text.secondary">
                  —
                </Typography>
              </TableCell>
              <TableCell>
                <Chip size="small" variant="outlined" label="launching…" />
              </TableCell>
              {actionsEnabled && <TableCell />}
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Box>
  );
}
