// Copyright OBSESC Authors
//
// The one time control (U11). Every custom OBSESC surface renders THIS —
// there is no second range dropdown, no second datetime pair, and no
// per-surface default. It reads and writes the shared store, which mirrors
// the Perses `start`/`end` params, which is what the dashboards run on.
//
// The control states the resolved window in words underneath itself, because
// the whole point of U10 is that `timestamp_ns >= 1785824670563000000` is not
// something a human can check. A relative range shows what it currently
// resolves to; an absolute one shows its own bounds back in UTC.

import { ReactElement } from 'react';
import { Box, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useSharedTimeRange } from '../hooks/use-shared-time-range';
import {
  RANGE_PRESETS,
  TimeRange,
  isoSeconds,
  localInputToMs,
  msToLocalInput,
  resolveRange,
} from '../model/time-range';

const mono = { fontFamily: '"JetBrains Mono", monospace' } as const;

const CUSTOM = '__custom__';

export interface TimeRangeControlProps {
  /** Rendered above the control; surfaces name what the window is FOR. */
  label?: string;
  /** Extra sentence after the resolved-window caption. */
  hint?: string;
  size?: 'small' | 'medium';
}

/**
 * `nowMs` is read here only to describe a relative range. Queries resolve it
 * again at submit time — a caption that is a second stale is honest, a query
 * bound that is a second stale is a different window.
 */
export function TimeRangeControl(props: TimeRangeControlProps): ReactElement {
  const { range, setRange } = useSharedTimeRange();
  const resolved = resolveRange(range, Date.now());
  const size = props.size ?? 'small';

  const onPreset = (value: string): void => {
    if (value === CUSTOM) {
      // Freeze whatever is on screen: switching to Custom must not silently
      // move the window the operator was already looking at.
      setRange({ kind: 'absolute', startMs: resolved.fromMs, endMs: resolved.toMs });
      return;
    }
    setRange({ kind: 'relative', duration: value });
  };

  const setBound = (which: 'startMs' | 'endMs', v: string): void => {
    const ms = localInputToMs(v);
    if (ms === null) return;
    const next: TimeRange = {
      kind: 'absolute',
      startMs: which === 'startMs' ? ms : resolved.fromMs,
      endMs: which === 'endMs' ? ms : resolved.toMs,
    };
    if (next.endMs <= next.startMs) return;
    setRange(next);
  };

  return (
    <Box data-testid="time-range-control">
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        {props.label !== undefined && (
          <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: '0.08em' }}>
            {props.label.toUpperCase()}
          </Typography>
        )}
        <TextField
          select
          size={size}
          label="Time range"
          value={range.kind === 'relative' ? range.duration : CUSTOM}
          onChange={(e) => onPreset(e.target.value)}
          sx={{ minWidth: 170 }}
        >
          {RANGE_PRESETS.map((p) => (
            <MenuItem key={p.duration} value={p.duration}>
              {p.label}
            </MenuItem>
          ))}
          <MenuItem value={CUSTOM}>Custom…</MenuItem>
        </TextField>
        {range.kind === 'absolute' && (
          <>
            <TextField
              type="datetime-local"
              size={size}
              value={msToLocalInput(range.startMs)}
              onChange={(e) => setBound('startMs', e.target.value)}
              inputProps={{ step: 1, 'aria-label': 'Range from' }}
              sx={{ '& input': { ...mono, fontSize: 12 } }}
            />
            <Typography color="text.secondary">→</Typography>
            <TextField
              type="datetime-local"
              size={size}
              value={msToLocalInput(range.endMs)}
              onChange={(e) => setBound('endMs', e.target.value)}
              inputProps={{ step: 1, 'aria-label': 'Range to' }}
              sx={{ '& input': { ...mono, fontSize: 12 } }}
            />
          </>
        )}
      </Stack>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 0.5, ...mono }}
        data-testid="time-range-resolved"
      >
        {isoSeconds(resolved.fromMs)} → {isoSeconds(resolved.toMs)} UTC
        {range.kind === 'relative' ? ' (resolved when the query runs)' : ''}
      </Typography>
      {props.hint !== undefined && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {props.hint}
        </Typography>
      )}
    </Box>
  );
}
