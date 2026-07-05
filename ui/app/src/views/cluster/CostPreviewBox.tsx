// Copyright OBSESC Authors
//
// Honest cost-preview box shared by the Add / Remove / Resize flows.
// Renders the SERVER's before/after monthly numbers (never invents its
// own), tinted amber for a cost increase and green for a decrease, with
// the server's pricing assumptions verbatim. Every figure is labeled
// approximate — these are on-demand estimates, not invoices.

import { ReactElement } from 'react';
import { Alert, Box, CircularProgress, Stack, Typography } from '@mui/material';
import { CostPreview, UnknownInstanceTypeError } from './use-cluster';
import { usdDeltaPretty } from './format';

interface CostPreviewBoxProps {
  preview: CostPreview | undefined;
  isLoading: boolean;
  error: unknown;
}

export function CostPreviewBox({ preview, isLoading, error }: CostPreviewBoxProps): ReactElement {
  if (isLoading) {
    return (
      <Stack direction="row" alignItems="center" gap={1}>
        <CircularProgress size={14} />
        <Typography variant="body2" color="text.secondary">
          Fetching cost preview…
        </Typography>
      </Stack>
    );
  }
  if (error instanceof UnknownInstanceTypeError) {
    return (
      <Alert severity="warning" variant="outlined">
        The node doesn&apos;t know this instance type&apos;s pricing — the action would proceed without a cost estimate.
      </Alert>
    );
  }
  if (error) {
    return (
      <Alert severity="warning" variant="outlined">
        Cost preview unavailable ({error instanceof Error ? error.message : String(error)}). You can still proceed, but
        no price estimate is shown.
      </Alert>
    );
  }
  if (!preview) {
    return (
      <Typography variant="body2" color="text.secondary">
        Cost preview pending…
      </Typography>
    );
  }

  // Amber tint for a cost increase, green for a decrease, neutral for no-op.
  let tint = 'background.lighter';
  if (preview.delta_monthly_usd > 0) tint = 'rgba(245, 158, 11, 0.12)';
  else if (preview.delta_monthly_usd < 0) tint = 'rgba(16, 185, 129, 0.12)';
  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 1,
        backgroundColor: tint,
      }}
    >
      <Typography variant="body2">
        <strong>{usdDeltaPretty(preview.delta_monthly_usd)}</strong> — approx ${preview.current_monthly_usd.toFixed(2)}
        /mo now → approx ${preview.projected_monthly_usd.toFixed(2)}/mo after ({preview.nodes_before} →{' '}
        {preview.nodes_after} node{preview.nodes_after === 1 ? '' : 's'}).
      </Typography>
      {preview.assumptions.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {preview.assumptions.join(' · ')}
        </Typography>
      )}
    </Box>
  );
}
