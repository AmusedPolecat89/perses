// Copyright OBSESC Authors
//
// Vertical (blue/green) resize confirm dialog. Pure UX scaffold today
// — the actual EC2 spin-up + WAL replay + ingest cutover ships with
// the backend cluster work. Confirm button is disabled with a
// "Pending cluster v0.2" tooltip until that lands.

import { ReactElement, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { findInstance, INSTANCE_TYPES, InstanceSpec, monthlyUsd } from './instance-types';

interface ResizeDialogProps {
  open: boolean;
  onClose: () => void;
  currentInstanceId: string;
}

export function ResizeDialog({ open, onClose, currentInstanceId }: ResizeDialogProps): ReactElement {
  const current = findInstance(currentInstanceId);
  const [selectedId, setSelectedId] = useState<string>(currentInstanceId);
  const selected = findInstance(selectedId);

  const deltaUsd = current && selected ? monthlyUsd(selected) - monthlyUsd(current) : 0;
  const isUpgrade = deltaUsd > 0;
  const isNoOp = deltaUsd === 0;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Resize node — vertical blue/green</DialogTitle>
      <DialogContent>
        <Stack gap={2}>
          <Typography variant="body2" color="text.secondary">
            Provision a new EC2 of the chosen size, replay the WAL onto it, cut ingest
            over once caught up, then tear down the old box. No data loss; brief outage
            window during cutover (typically &lt;30s).
          </Typography>

          <Box>
            <Typography variant="overline" color="text.secondary">
              Choose instance type
            </Typography>
            <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>
              {INSTANCE_TYPES.map((spec) => (
                <Chip
                  key={spec.id}
                  label={`${spec.id} · ${spec.vcpu} vCPU / ${spec.memoryGb} GB`}
                  color={spec.id === selectedId ? 'primary' : 'default'}
                  variant={spec.id === selectedId ? 'filled' : 'outlined'}
                  onClick={() => setSelectedId(spec.id)}
                />
              ))}
            </Stack>
            {selected && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {selected.recommendedFor}
              </Typography>
            )}
          </Box>

          <Divider />

          <Stack direction="row" justifyContent="space-between" alignItems="baseline">
            <Box>
              <Typography variant="caption" color="text.secondary">
                Current
              </Typography>
              <Typography variant="body1">
                {current?.id ?? '—'} · approx ${current ? monthlyUsd(current).toFixed(0) : '?'}/mo
              </Typography>
            </Box>
            <Box textAlign="right">
              <Typography variant="caption" color="text.secondary">
                After resize
              </Typography>
              <Typography variant="body1">
                {selected?.id ?? '—'} · approx ${selected ? monthlyUsd(selected).toFixed(0) : '?'}/mo
              </Typography>
            </Box>
          </Stack>

          <Box
            sx={{
              p: 1.5,
              borderRadius: 1,
              backgroundColor: isNoOp
                ? 'background.lighter'
                : isUpgrade
                  ? 'rgba(245, 158, 11, 0.12)' // amber tint for cost increase
                  : 'rgba(16, 185, 129, 0.12)', // green tint for cost decrease
            }}
          >
            <Typography variant="body2">
              {isNoOp ? (
                'Same instance — no resize action.'
              ) : (
                <>
                  <strong>
                    {isUpgrade ? '+' : ''}${deltaUsd.toFixed(2)}/mo
                  </strong>{' '}
                  ({isUpgrade ? 'higher' : 'lower'} EC2 cost). Storage and S3 charges
                  unchanged.
                </>
              )}
            </Typography>
            {!isNoOp && (
              <Typography variant="caption" color="text.secondary">
                Estimated rollover: ~2–5 min depending on WAL replay backlog.
              </Typography>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Tooltip title="Pending cluster control plane — backend caller lands in v0.2">
          <span>
            <Button variant="contained" disabled>
              Confirm resize
            </Button>
          </span>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
}

export type { InstanceSpec };
