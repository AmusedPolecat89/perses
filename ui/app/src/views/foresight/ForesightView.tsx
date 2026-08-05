// Copyright OBSESC Authors
//
// Foresight (Lane U5) — the world-model surface. Two questions the
// archive can answer about the FUTURE:
//
//   1. Forecast: "given how this service is moving, which templates
//      come next?" (POST /v1/forecast — sparse Markov transitions
//      accumulated in .obsc section 6).
//   2. What-if: "propagate the current state N steps — which paths of
//      least resistance end in a failure-ish template?" (POST /v1/whatif
//      — deterministic max-product graph propagation, not ML).
//
// HONESTY CONTRACT (PR standard 3): the `approximation` field
// ("arrival-order, no trace correlation") is an ALWAYS-VISIBLE banner,
// never a tooltip; `low_support` (+ the evidence floor), `overflow_mass`
// truncation, and the response `warning` all render, non-dismissable.
//
// Direct-fetch pattern (ObsescExploreView): no plugin-client import;
// wire types live in ./foresight-api.ts, kept in sync with client.ts.

import { ReactElement, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  MenuItem,
  Slider,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useCapabilities } from '../../hooks/use-capabilities';
import { AsyncOpBar, AsyncOpStatus, asyncOpTriggerProps } from '../../components/progress/AsyncOp';
import { useAsyncOp } from '../../components/progress/useAsyncOp';
import {
  DEFAULT_TOP,
  FETCH_TIMEOUT_MS,
  fetchForecast,
  fetchWhatIf,
  MAX_HISTORY_RANGE_SECONDS,
  MAX_WHATIF_STEPS,
  ObsescForecastResponse,
  ObsescGatherEvidence,
  ObsescWhatIfHit,
  ObsescWhatIfResponse,
} from './foresight-api';

const mono = { fontFamily: '"JetBrains Mono", monospace' } as const;

const card = {
  borderRadius: 1.5,
  border: '1px solid',
  borderColor: 'background.border',
  backgroundColor: 'background.paper',
  padding: 2.5,
} as const;

/** De-emphasis for low-support entries — visible but visually quieter. */
const LOW_SUPPORT_OPACITY = 0.55;

// History-range picker options — every option ≤ the server's 7-day cap
// (MAX_HISTORY_RANGE_NS), mirrored client-side so a request can never 400
// on range.
const RANGES: Array<{ label: string; seconds: number }> = [
  { label: 'Last hour', seconds: 3600 },
  { label: 'Last 6 hours', seconds: 6 * 3600 },
  { label: 'Last 24 hours', seconds: 24 * 3600 },
  { label: 'Last 3 days', seconds: 3 * 86_400 },
  { label: 'Last 7 days (max)', seconds: MAX_HISTORY_RANGE_SECONDS },
];

function rangeNs(seconds: number): { from_ns: number; to_ns: number } {
  // Belt-and-braces clamp to the server bound (options are already ≤ it).
  const s = Math.min(seconds, MAX_HISTORY_RANGE_SECONDS);
  const now = Date.now() * 1e6;
  return { from_ns: Math.floor(now - s * 1e9), to_ns: Math.floor(now) };
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

// ─── Shared honesty rendering ──────────────────────────────────────────

interface HonestyShape {
  approximation: string;
  evidence: ObsescGatherEvidence;
  low_support: boolean;
  warning?: string;
  state_source: 'provided' | 'derived';
}

/**
 * The non-negotiable banners (PR standard 3). The `approximation` string
 * renders verbatim, always visible while a result is on screen — no
 * onClose, no tooltip. Response-level `warning` and `low_support` are
 * alert banners; `overflow_mass > 0` is a visible truncation warning.
 */
function HonestyBanners({ resp }: { resp: HonestyShape }): ReactElement {
  return (
    <Stack gap={1} sx={{ mt: 1.5 }}>
      <Alert severity="info" icon={false} data-testid="approximation-banner">
        <strong>Approximation:</strong> {resp.approximation}
      </Alert>
      {resp.warning !== undefined && (
        <Alert severity="warning" data-testid="response-warning">
          {resp.warning}
        </Alert>
      )}
      {resp.low_support && (
        <Alert severity="warning" data-testid="all-low-support">
          Every prediction here is low-support (below {resp.evidence.low_support_floor} observations) — treat this as a
          hint, not a forecast.
        </Alert>
      )}
      {resp.evidence.overflow_mass > 0 && (
        <Alert severity="warning" data-testid="overflow-warning">
          Truncated: {resp.evidence.overflow_mass.toLocaleString()} transitions folded into overflow by the per-window
          edge bound — probabilities are computed against the kept edges only.
        </Alert>
      )}
    </Stack>
  );
}

function StateSourceLine({ resp }: { resp: HonestyShape }): ReactElement {
  return (
    <Typography variant="caption" color="text.secondary" data-testid="state-source">
      {resp.state_source === 'derived' ? 'state derived from newest window' : 'state provided in the request'}
    </Typography>
  );
}

/** Evidence footer: the observation counts every answer stands on. */
function EvidenceFooter({ evidence }: { evidence: ObsescGatherEvidence }): ReactElement {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }} data-testid="evidence-footer">
      Evidence: {evidence.nodes} node{evidence.nodes === 1 ? '' : 's'} ·{' '}
      {evidence.windows_with_transitions.toLocaleString()} windows with transitions ·{' '}
      {evidence.scanned_files.toLocaleString()} files scanned · {evidence.total_transitions.toLocaleString()}{' '}
      transitions observed · {evidence.overflow_mass.toLocaleString()} folded into overflow · low-support floor ={' '}
      {evidence.low_support_floor}
    </Typography>
  );
}

/** Pattern text with the null fallback: decimal key + "unknown template". */
function PatternText({
  pattern,
  patternKey,
  dim,
}: {
  pattern: string | null;
  patternKey: string;
  dim: boolean;
}): ReactElement {
  return (
    <Stack direction="row" gap={0.75} alignItems="center" sx={{ minWidth: 0 }}>
      <Typography
        variant="body2"
        sx={{
          ...mono,
          fontSize: 12,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          opacity: dim ? LOW_SUPPORT_OPACITY : 1,
        }}
        title={pattern ?? patternKey}
      >
        {pattern ?? patternKey}
      </Typography>
      {pattern === null && (
        <Chip size="small" variant="outlined" label="unknown template" data-testid="unknown-template" />
      )}
    </Stack>
  );
}

function LowSupportChip({ floor }: { floor: number }): ReactElement {
  return (
    <Chip
      size="small"
      variant="outlined"
      color="warning"
      label={`low support — below ${floor} observations`}
      data-testid="low-support-chip"
      sx={{ opacity: LOW_SUPPORT_OPACITY }}
    />
  );
}

// ─── Forecast section ──────────────────────────────────────────────────

function ForecastSection({ resp, error }: { resp: ObsescForecastResponse | null; error: string | null }): ReactElement {
  if (error) {
    return (
      <Alert severity="error" sx={{ mt: 2, ...mono, fontSize: 12 }}>
        {error}
      </Alert>
    );
  }
  if (!resp) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        Pick a service and a history range, then run the forecast.
      </Typography>
    );
  }
  const floor = resp.evidence.low_support_floor;
  return (
    <Box data-testid="forecast-results">
      <HonestyBanners resp={resp} />
      <Stack direction="row" justifyContent="space-between" sx={{ mt: 1.5, mb: 0.5 }}>
        <Typography variant="body2" color="text.secondary">
          {resp.predictions.length} predicted next template
          {resp.predictions.length === 1 ? '' : 's'}
        </Typography>
        <StateSourceLine resp={resp} />
      </Stack>
      {resp.predictions.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          No transitions observed for this service in the selected range — nothing to forecast from yet.
        </Typography>
      )}
      <Stack gap={1}>
        {resp.predictions.map((p) => (
          <Stack
            key={p.key}
            direction="row"
            gap={1.5}
            alignItems="center"
            data-testid="prediction-row"
            data-low-support={p.low_support ? 'true' : 'false'}
            sx={{
              borderTop: '1px solid rgba(128,128,128,0.15)',
              paddingTop: 1,
            }}
          >
            <Box sx={{ width: 170, flexShrink: 0, opacity: p.low_support ? LOW_SUPPORT_OPACITY : 1 }}>
              <LinearProgress
                variant="determinate"
                value={Math.max(0, Math.min(1, p.probability)) * 100}
                sx={{ height: 8, borderRadius: 1 }}
                aria-label={`probability ${pct(p.probability)}`}
              />
              <Typography variant="caption" sx={mono}>
                {pct(p.probability)}
              </Typography>
            </Box>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <PatternText pattern={p.pattern} patternKey={p.key} dim={p.low_support} />
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ flexShrink: 0, opacity: p.low_support ? LOW_SUPPORT_OPACITY : 1 }}
            >
              support {p.support.toLocaleString()}
            </Typography>
            {p.low_support && <LowSupportChip floor={floor} />}
          </Stack>
        ))}
      </Stack>
      <EvidenceFooter evidence={resp.evidence} />
    </Box>
  );
}

// ─── What-if section ───────────────────────────────────────────────────

/** One failure path: the template chain, ending at the failure-ish hit. */
function WhatIfPath({ hit, floor }: { hit: ObsescWhatIfHit; floor: number }): ReactElement {
  const dim = hit.low_support;
  return (
    <Box
      data-testid="whatif-hit"
      data-low-support={hit.low_support ? 'true' : 'false'}
      sx={{ borderTop: '1px solid rgba(128,128,128,0.15)', paddingTop: 1 }}
    >
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        <Box sx={{ width: 170, flexShrink: 0, opacity: dim ? LOW_SUPPORT_OPACITY : 1 }}>
          <LinearProgress
            variant="determinate"
            value={Math.max(0, Math.min(1, hit.probability)) * 100}
            sx={{ height: 8, borderRadius: 1 }}
            aria-label={`path probability ${pct(hit.probability)}`}
          />
          <Typography variant="caption" sx={mono}>
            {pct(hit.probability)}
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ opacity: dim ? LOW_SUPPORT_OPACITY : 1 }}>
          {hit.steps} step{hit.steps === 1 ? '' : 's'}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ opacity: dim ? LOW_SUPPORT_OPACITY : 1 }}
          data-testid="min-edge-support"
        >
          weakest edge: {hit.min_edge_support.toLocaleString()}
        </Typography>
        {hit.low_support && <LowSupportChip floor={floor} />}
      </Stack>
      {/* The path itself: template patterns chained to the failure-ish end.
          path_patterns is aligned with path; null → decimal key fallback. */}
      <Stack
        direction="row"
        gap={0.5}
        alignItems="center"
        flexWrap="wrap"
        sx={{ mt: 0.75, opacity: dim ? LOW_SUPPORT_OPACITY : 1 }}
      >
        {hit.path.map((key, i) => {
          const pattern = hit.path_patterns[i] ?? null;
          const isLast = i === hit.path.length - 1;
          return (
            <Stack key={`${key}-${i}`} direction="row" gap={0.5} alignItems="center">
              <Chip
                size="small"
                variant={isLast ? 'filled' : 'outlined'}
                color={isLast ? 'error' : 'default'}
                label={pattern ?? `${key} (unknown template)`}
                sx={{ ...mono, fontSize: 11, maxWidth: 340 }}
                title={pattern ?? key}
              />
              {!isLast && (
                <Typography variant="caption" color="text.secondary">
                  →
                </Typography>
              )}
            </Stack>
          );
        })}
      </Stack>
    </Box>
  );
}

function WhatIfSection({ resp, error }: { resp: ObsescWhatIfResponse | null; error: string | null }): ReactElement {
  if (error) {
    return (
      <Alert severity="error" sx={{ mt: 2, ...mono, fontSize: 12 }}>
        {error}
      </Alert>
    );
  }
  if (!resp) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        Pick a service, a history range and a propagation depth, then explore the failure paths.
      </Typography>
    );
  }
  const floor = resp.evidence.low_support_floor;
  return (
    <Box data-testid="whatif-results">
      <HonestyBanners resp={resp} />
      <Stack direction="row" justifyContent="space-between" sx={{ mt: 1.5, mb: 0.5 }}>
        <Typography variant="body2" color="text.secondary">
          {resp.hits.length} failure path{resp.hits.length === 1 ? '' : 's'} within {resp.steps} step
          {resp.steps === 1 ? '' : 's'}
        </Typography>
        <StateSourceLine resp={resp} />
      </Stack>
      {resp.hits.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          No path from the current state reaches a failure-ish template within {resp.steps} step
          {resp.steps === 1 ? '' : 's'} — in the observed dynamics, this state does not drift into failure at this
          depth.
        </Typography>
      )}
      <Stack gap={1.5}>
        {resp.hits.map((h, i) => (
          <WhatIfPath key={`${h.key}-${i}`} hit={h} floor={floor} />
        ))}
      </Stack>
      <EvidenceFooter evidence={resp.evidence} />
    </Box>
  );
}

// ─── The view ──────────────────────────────────────────────────────────

export default function ForesightView(): ReactElement {
  const caps = useCapabilities();

  const [tab, setTab] = useState<'forecast' | 'whatif'>('forecast');
  const [service, setService] = useState('');
  const [rangeSecs, setRangeSecs] = useState(24 * 3600);
  const [steps, setSteps] = useState(4);

  // TWO hook instances replace the `beginRequest` double-flag dance: that
  // existed only because ONE inflight ref served two independent ops, so a
  // superseded request could never clear its own busy flag. Each op now
  // owns its own generation, deadline and Cancel.
  const forecast = useAsyncOp<ObsescForecastResponse, [string, number]>(
    async (ctx, svc, secs) => {
      const { from_ns, to_ns } = rangeNs(secs);
      const resp = await fetchForecast({ service: svc, from_ns, to_ns, top: DEFAULT_TOP }, ctx.signal);
      return {
        data: resp,
        receipt: `${resp.predictions.length} prediction${resp.predictions.length === 1 ? '' : 's'}`,
      };
    },
    { label: 'Forecast', timeoutMs: FETCH_TIMEOUT_MS }
  );

  const whatif = useAsyncOp<ObsescWhatIfResponse, [string, number, number]>(
    async (ctx, svc, secs, depth) => {
      const { from_ns, to_ns } = rangeNs(secs);
      // steps is slider-bounded 1..=16 — the server 400s outside.
      const bounded = Math.max(1, Math.min(MAX_WHATIF_STEPS, depth));
      const resp = await fetchWhatIf({ service: svc, from_ns, to_ns, steps: bounded, top: DEFAULT_TOP }, ctx.signal);
      return { data: resp, receipt: `${resp.hits.length} path${resp.hits.length === 1 ? '' : 's'}` };
    },
    { label: 'What-if', timeoutMs: FETCH_TIMEOUT_MS }
  );

  // Stricter than the progress pattern needs, and deliberately kept: stale
  // predictions must never sit under a new service/range/steps selection —
  // that is an honesty issue, not a UX one.
  const resetOps = useRef({ forecast: forecast.reset, whatif: whatif.reset });
  resetOps.current = { forecast: forecast.reset, whatif: whatif.reset };
  useEffect(() => {
    resetOps.current.forecast();
    resetOps.current.whatif();
  }, [service, rangeSecs, steps]);

  const forecastResp = forecast.state.data;
  const forecastError = forecast.state.error;
  const whatifResp = whatif.state.data;
  const whatifError = whatif.state.error;

  // ── Tri-state gating (PR standard 4): loading ≠ unreachable ≠ disabled ──
  let gate: ReactElement | null = null;
  if (caps.isLoading) {
    gate = (
      <Stack direction="row" gap={1} alignItems="center" sx={card}>
        <CircularProgress size={18} />
        <Typography variant="body2" color="text.secondary">
          checking node capabilities…
        </Typography>
      </Stack>
    );
  } else if (caps.unavailable) {
    gate = (
      <Alert severity="error" data-testid="foresight-unreachable">
        The node is unreachable — capabilities could not be read, so it is unknown whether transitions are enabled.
        Check that obsesc-node is up and the proxy points at it.
      </Alert>
    );
  } else if (!caps.forecast) {
    gate = (
      <Alert severity="info" data-testid="foresight-disabled">
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          transitions disabled: summary.transition_max_edges = 0
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          This node is not recording template transitions, so there is no world-model to forecast from. Set{' '}
          <code>summary.transition_max_edges</code> &gt; 0 in the node&apos;s config.yaml and restart — new windows
          start accumulating dynamics immediately (alerting/config is node-side; there is no config API).
        </Typography>
      </Alert>
    );
  }

  return (
    <Box sx={{ padding: 3, maxWidth: 1280, mx: 'auto' }}>
      <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
        Foresight
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2.5 }}>
        The archive&apos;s learned dynamics: template-transition matrices accumulated passively in every .obsc. Forecast
        where a service is heading; propagate what-if states toward known failure templates. Deterministic graph theory
        over your own history — with the evidence shown, always.
      </Typography>

      {gate ?? (
        <Box sx={card}>
          <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
            <TextField
              size="small"
              label="Service"
              value={service}
              onChange={(e) => setService(e.target.value)}
              sx={{ minWidth: 220 }}
              slotProps={{ input: { sx: mono } }}
            />
            <TextField
              size="small"
              select
              label="History range (max 7 days)"
              value={rangeSecs}
              onChange={(e) => setRangeSecs(Number(e.target.value))}
              sx={{ minWidth: 200 }}
            >
              {RANGES.map((r) => (
                <MenuItem key={r.seconds} value={r.seconds}>
                  {r.label}
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <Tabs value={tab} onChange={(_, v) => setTab(v as 'forecast' | 'whatif')} sx={{ mt: 1.5 }}>
            <Tab label="Forecast" value="forecast" data-testid="tab-forecast" />
            <Tab label="What-if" value="whatif" data-testid="tab-whatif" />
          </Tabs>

          {tab === 'forecast' && (
            <Box sx={{ mt: 1.5 }}>
              <AsyncOpBar state={forecast.state} testId="asyncop-bar-forecast" />
              <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
                <Button
                  variant="contained"
                  onClick={() => forecast.run(service, rangeSecs)}
                  disabled={service.trim().length === 0}
                  {...asyncOpTriggerProps(forecast.state)}
                >
                  {forecast.state.phase === 'running' ? 'Forecasting…' : 'Forecast'}
                </Button>
                <Typography variant="caption" color="text.secondary">
                  top {DEFAULT_TOP} next templates from the current state
                </Typography>
              </Stack>
              <AsyncOpStatus
                id="foresight-forecast"
                state={forecast.state}
                label="Forecast"
                runningHint="Gathering transition matrices…"
                onCancel={forecast.cancel}
              />
              <Box sx={{ opacity: forecast.state.phase === 'running' ? 0.45 : 1 }}>
                <ForecastSection resp={forecastResp} error={forecastError} />
              </Box>
            </Box>
          )}

          {tab === 'whatif' && (
            <Box sx={{ mt: 1.5 }}>
              <AsyncOpBar state={whatif.state} testId="asyncop-bar-whatif" />
              <Stack direction="row" gap={2.5} alignItems="center" flexWrap="wrap">
                <Box sx={{ width: 260 }}>
                  <Typography variant="caption" color="text.secondary">
                    Propagation depth: {steps} step{steps === 1 ? '' : 's'} (1–
                    {MAX_WHATIF_STEPS})
                  </Typography>
                  <Slider
                    size="small"
                    value={steps}
                    onChange={(_, v) => setSteps(v as number)}
                    min={1}
                    max={MAX_WHATIF_STEPS}
                    step={1}
                    marks
                    valueLabelDisplay="auto"
                    aria-label="propagation depth in steps"
                  />
                </Box>
                <Button
                  variant="contained"
                  onClick={() => whatif.run(service, rangeSecs, steps)}
                  disabled={service.trim().length === 0}
                  {...asyncOpTriggerProps(whatif.state)}
                >
                  {whatif.state.phase === 'running' ? 'Exploring…' : 'Explore failure paths'}
                </Button>
              </Stack>
              <AsyncOpStatus
                id="foresight-whatif"
                state={whatif.state}
                label="What-if"
                runningHint="Propagating state through the transition graph…"
                onCancel={whatif.cancel}
              />
              <Box sx={{ opacity: whatif.state.phase === 'running' ? 0.45 : 1 }}>
                <WhatIfSection resp={whatifResp} error={whatifError} />
              </Box>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
