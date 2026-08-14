// Copyright OBSESC Authors
//
// The rendered half of `describeOpError`: the error state every Explore
// operation shows instead of the raw string `useAsyncOp` captured.
//
// It keeps the elapsed-time indicator that already lives in `AsyncOpStatus`
// ("✗ failed after 0.1s") — that line is a measurement and it is good. What it
// replaces is the second line, which used to be a JavaScript class name.

import { ReactElement } from 'react';
import { Alert, Typography } from '@mui/material';
import { describeOpError } from '../utils/op-error';

const mono = { fontFamily: '"JetBrains Mono", monospace' } as const;

export interface OpErrorAlertProps {
  /** `AsyncOpState.error`. Render nothing when it is null. */
  error: string | null;
  /** The operation, in the surrounding copy's voice: "needle search", "grep". */
  what: string;
  testId?: string;
}

export function OpErrorAlert({ error, what, testId }: OpErrorAlertProps): ReactElement | null {
  if (error === null) return null;
  const { headline, advice, detail } = describeOpError(error, what);
  return (
    <Alert severity="error" sx={{ mt: 1.5 }} data-testid={testId ?? 'op-error'}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {headline}
      </Typography>
      {advice !== null && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {advice}
        </Typography>
      )}
      {detail !== null && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ ...mono, display: 'block', mt: 0.75 }}
          data-testid={`${testId ?? 'op-error'}-detail`}
        >
          {detail}
        </Typography>
      )}
    </Alert>
  );
}
