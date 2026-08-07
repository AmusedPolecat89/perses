// Copyright OBSESC Authors
//
// Investigate — differential forensics (Lane U3). The obsc_diff flow from
// the capability brief: "select a broken window and a healthy baseline
// window, hit diff." Pick a service and two windows (baseline auto-suggested
// as the incident window −24h, both editable) and get the rate-normalized
// structural delta from /v1/diff — template rate deltas (new / absent /
// changed), latency-quantile shifts, dimension and cardinality deltas, and
// cross-tab churn. Entirely in-memory server-side over two .obsc payloads;
// no raw scan.
//
// Direct-fetch pattern (same as ObsescExploreView / use-node-stats): this
// surface must work before any datasource exists. Types below mirror the
// Rust `DiffReport` wire shape locally.
//
// NOTE (accepted drift for this wave): the report rendering here duplicates
// the plugin renderer — keep in sync with DiffReportView
// (ui/plugins/datasource-obsesc/src/plugins/investigate/DiffReportView.tsx).

import { ReactElement, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { AsyncOpBar, AsyncOpStatus, asyncOpTriggerProps } from '../../components/progress/AsyncOp';
import { useAsyncOp } from '../../components/progress/useAsyncOp';
import { eitherSignal } from '../../utils/either-signal';
import { TimeRangeControl } from '../../components/TimeRangeControl';
import { useSharedTimeRange } from '../../hooks/use-shared-time-range';
import { localInputToMs, msToLocalInput, rangeKey, resolveRange } from '../../model/time-range';

const API = '/obsesc-api';
// Cross-node diffs gather from every shard owner — allow the long tail.
const FETCH_TIMEOUT_MS = 60_000;
const NS_PER_MS = 1e6;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const mono = { fontFamily: '"JetBrains Mono", monospace' } as const;

const card = {
  borderRadius: 1.5,
  border: '1px solid',
  borderColor: 'background.border',
  backgroundColor: 'background.paper',
  padding: 2.5,
} as const;

// ─── wire types (local mirror of the Rust DiffReport) ──────────────────

type DeltaKind = 'New' | 'Absent' | 'Changed';
// Externally-tagged Rust enum; Id is a decimal string (u64 > 2^53).
type TemplateKey = { Id: string } | { Pattern: string };

interface TemplateDelta {
  key: TemplateKey;
  pattern: string | null;
  baseline_count: number;
  incident_count: number;
  baseline_rate: number;
  incident_rate: number;
  rate_delta: number;
  kind: DeltaKind;
}

interface QuantileShift {
  attribute: string;
  baseline_p50: number;
  incident_p50: number;
  p50_delta: number;
  baseline_p95: number;
  incident_p95: number;
  p95_delta: number;
  baseline_p99: number;
  incident_p99: number;
  p99_delta: number;
}

interface DimValueDelta {
  value: string;
  baseline_rate: number;
  incident_rate: number;
  rate_delta: number;
  kind: DeltaKind;
}

type DimensionDelta = { Full: { attribute: string; values: DimValueDelta[] } } | { Sketched: { attribute: string } };

interface CardinalityShift {
  attribute: string;
  baseline_distinct: number;
  incident_distinct: number;
  distinct_delta: number;
}

interface CrosstabDelta {
  row_axis: string;
  col_axis: string;
  baseline_total: number;
  incident_total: number;
  rate_l1_delta: number;
  cells_compared: number;
  shape_mismatch: boolean;
}

interface DiffReport {
  service: string;
  baseline_window: [number, number];
  incident_window: [number, number];
  baseline_event_count: number;
  incident_event_count: number;
  template_match: 'Id' | 'Pattern';
  template_deltas: TemplateDelta[];
  quantile_shifts: QuantileShift[];
  dimension_deltas: DimensionDelta[];
  cardinality_shifts: CardinalityShift[];
  // serde skip_serializing_if — ABSENT when no pair had CMS on both sides.
  crosstab_deltas?: CrosstabDelta[];
  notes: string[];
}

// ─── helpers ────────────────────────────────────────────────────────────

function localInputToNs(v: string): number | null {
  const ms = localInputToMs(v);
  return ms === null ? null : ms * NS_PER_MS;
}

/** Decimals track magnitude: never more precision than the number means. */
function percentDecimals(abs: number): number {
  if (abs >= 10) return 1;
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 3;
  return 4;
}

/**
 * U13. Every `*_rate` on this report is a per-event fraction (count ÷ window
 * events), so the interesting ones live around 1e−4 and used to render as
 * `-4.12e-4` beside `+3.38e-4` — correct, and impossible to rank by eye.
 *
 * Percent-of-events is ONE unit across the whole range: a template that is
 * 40 % of the traffic and one that is 0.0338 % of it are still comparable at
 * a glance, which two exponents never are. Anything smaller than the last
 * displayed digit says so ("<0.0001%") rather than rounding itself away to a
 * flat 0 — a rate that is tiny and a rate that is absent are different facts.
 */
function fmtRate(r: number): string {
  if (!Number.isFinite(r)) return '—';
  if (r === 0) return '0%';
  const pct = r * 100;
  const abs = Math.abs(pct);
  if (abs < 0.0001) return `${pct < 0 ? '-' : ''}<0.0001%`;
  return `${pct.toFixed(percentDecimals(abs))}%`;
}

function fmtDelta(r: number): string {
  if (!Number.isFinite(r)) return '—';
  if (r === 0) return '0%';
  return r > 0 ? `+${fmtRate(r)}` : `-${fmtRate(Math.abs(r))}`;
}

function absoluteDecimals(abs: number): number {
  if (abs >= 100) return 0;
  if (abs >= 1) return 1;
  return 3;
}

/**
 * Quantile shifts are NOT rates — they are absolute movements in the
 * attribute's own units, sitting next to `baseline.toFixed(1) →
 * incident.toFixed(1)`. Running them through the percent formatter would
 * relabel milliseconds as a percentage, which is a worse defect than the one
 * U13 reports.
 */
function fmtNumDelta(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  return `${v >= 0 ? '+' : '-'}${abs.toFixed(absoluteDecimals(abs))}`;
}

function tsPretty(ns: number): string {
  return new Date(ns / 1e6).toISOString().replace('T', ' ').slice(0, 19);
}

/** Largest |Δ| in a section — the scale every bar in that section shares. */
function maxAbs(values: number[]): number {
  return values.reduce((m, v) => (Number.isFinite(v) && Math.abs(v) > m ? Math.abs(v) : m), 0);
}

function templateLabel(d: TemplateDelta): string {
  if (d.pattern) return d.pattern;
  if ('Id' in d.key) return `template #${d.key.Id}`;
  return d.key.Pattern;
}

const MATCH_EXPLAIN: Record<'Id' | 'Pattern', { label: string; explain: string }> = {
  Id: {
    label: 'Matched by Id — single-miner fidelity',
    explain:
      'Templates were matched by miner id: both windows come from one miner id-space ' +
      '(single owner), so every template delta is exact — full fidelity.',
  },
  Pattern: {
    label: 'Matched by Pattern — cross-shard pattern matching',
    explain:
      'Templates were matched by rendered pattern text because the windows span shards or ' +
      'nodes with different miner id-spaces. Distinct templates that render to the same ' +
      'pattern are merged — reduced fidelity vs id matching.',
  },
};

// ─── the view ───────────────────────────────────────────────────────────

function InvestigateView(): ReactElement {
  const [service, setService] = useState('svc-000');

  // U11: the INCIDENT window is the shared range — the same one the
  // dashboards and Explore use — so an investigation that starts on a
  // dashboard arrives here already pointed at the right window. The BASELINE
  // stays local by definition: it is a second, deliberately different window.
  const { range } = useSharedTimeRange();
  // Pin the clock per range identity, so a RELATIVE range does not re-derive
  // the baseline fields on every render (a datetime-local that ticks once a
  // second cannot be typed into). The submitted window is resolved again at
  // click time; see `run`.
  const rangeK = rangeKey(range);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const previewIncident = useMemo(() => resolveRange(range, Date.now()), [rangeK]);

  // `null` = "still incident −24h", and it FOLLOWS the incident window when
  // that moves. Only an explicit edit pins the baseline in place.
  const [baselineEdit, setBaselineEdit] = useState<{ from: string; to: string } | null>(null);
  const baselineFrom = baselineEdit?.from ?? msToLocalInput(previewIncident.fromMs - DAY_MS);
  const baselineTo = baselineEdit?.to ?? msToLocalInput(previewIncident.toMs - DAY_MS);

  /** Resolve everything against ONE clock reading, at submit time. */
  const boundsFor = (
    nowMs: number
  ): {
    baseline_from_ns: number | null;
    baseline_to_ns: number | null;
    incident_from_ns: number | null;
    incident_to_ns: number | null;
  } => {
    const incident = resolveRange(range, nowMs);
    const baseline =
      baselineEdit === null
        ? { from: incident.fromNs - DAY_MS * NS_PER_MS, to: incident.toNs - DAY_MS * NS_PER_MS }
        : { from: localInputToNs(baselineEdit.from), to: localInputToNs(baselineEdit.to) };
    return {
      baseline_from_ns: baseline.from,
      baseline_to_ns: baseline.to,
      incident_from_ns: incident.fromNs,
      incident_to_ns: incident.toNs,
    };
  };

  const preview = boundsFor(previewIncident.toMs);
  const invalid =
    service.trim() === '' ||
    Object.values(preview).some((v) => v === null) ||
    (preview.baseline_from_ns as number) >= (preview.baseline_to_ns as number) ||
    (preview.incident_from_ns as number) >= (preview.incident_to_ns as number);

  // The hook supplies the generation guard the manual `abortRef.current === ctl`
  // dance used to approximate, plus elapsed (there was none) and a timeout
  // that is reported as a timeout rather than as an operator cancel.
  const diff = useAsyncOp<DiffReport, [string, ReturnType<typeof boundsFor>]>(
    async (ctx, svc, windows) => {
      const r = await fetch(`${API}/v1/diff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: svc.trim(), ...windows }),
        // The hook's deadline AND its abort — the hook owns both, so this
        // composition only exists to keep the fetch honest if a caller ever
        // threads a second signal.
        signal: eitherSignal(ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const report = (await r.json()) as DiffReport;
      return {
        data: report,
        receipt: `${report.template_deltas.length} template delta${report.template_deltas.length === 1 ? '' : 's'}`,
      };
    },
    { label: 'Run diff', timeoutMs: FETCH_TIMEOUT_MS }
  );

  const running = diff.state.phase === 'running';
  const report = diff.state.data;
  const error = diff.state.error;

  const run = (): void => {
    if (invalid) return;
    // Resolve "Last 1 hour" NOW, not when the page was opened.
    diff.run(service, boundsFor(Date.now()));
  };

  // Errors here read "Error: 404: no summary data in the baseline window" —
  // match the backend's real empty-window text (same fix as DiffDialog).
  const emptyWindow = error !== null && /: 404: |no summary data/i.test(error);

  return (
    <Box sx={{ padding: 3, maxWidth: 1200, margin: '0 auto' }}>
      <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
        Investigate
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        Differential forensics: pick a broken window and a healthy baseline, hit diff. The comparison runs over the
        summary sketches in memory — no raw scan, rate-normalized so window sizes don&apos;t have to match.
      </Typography>

      <Box sx={card}>
        <AsyncOpBar state={diff.state} testId="asyncop-bar-investigate" />
        <Stack direction="row" gap={2} flexWrap="wrap" alignItems="flex-end">
          <TextField
            label="Service"
            value={service}
            onChange={(e) => setService(e.target.value)}
            size="small"
            slotProps={{ input: { sx: { ...mono, fontSize: 13 } } }}
          />
          {/* U11: the incident window IS the shared range. No second picker. */}
          <TimeRangeControl
            label="Incident (broken)"
            hint="Shared with the dashboards and Explore — set it once, it follows you."
          />
          <WindowFields
            label="Baseline (healthy)"
            from={baselineFrom}
            to={baselineTo}
            onFrom={(v) => setBaselineEdit({ from: v, to: baselineTo })}
            onTo={(v) => setBaselineEdit({ from: baselineFrom, to: v })}
            ariaPrefix="Baseline"
          />
        </Stack>
        <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap" sx={{ mt: 2 }}>
          {/* Precondition-only disable: a re-click supersedes the running diff.
              data-testid, NOT aria-label: the label deliberately flips with the
              phase and a screen reader should announce that, so the accessible
              name must stay the live text. An exact-name locator goes stale the
              instant it flips, which presents as "the control vanished". */}
          <Button
            variant="contained"
            data-testid="investigate-diff-btn"
            onClick={run}
            disabled={invalid}
            {...asyncOpTriggerProps(diff.state)}
          >
            {running ? 'Running diff…' : 'Run diff'}
          </Button>
          {baselineEdit === null ? (
            <Typography variant="caption" color="text.secondary">
              baseline tracks the incident window −24h
            </Typography>
          ) : (
            <Button variant="outlined" size="small" onClick={() => setBaselineEdit(null)}>
              Re-track baseline (incident −24h)
            </Button>
          )}
          {invalid && (
            <Typography variant="caption" color="warning.main">
              service + two valid windows (from &lt; to) required
            </Typography>
          )}
        </Stack>
        <AsyncOpStatus
          id="investigate-diff"
          state={diff.state}
          label="Run diff"
          runningHint="Running diff — cross-node diffs gather from every shard owner…"
          idleHint="No diff run yet — set the windows and hit Run diff."
          onCancel={diff.cancel}
        />
      </Box>

      {emptyWindow && (
        <Alert severity="info" sx={{ mt: 2 }}>
          No summary data in one of the windows — widen a window or move the baseline to a period this node has data
          for.
        </Alert>
      )}
      {error && !emptyWindow && (
        <Alert severity="error" sx={{ mt: 2, ...mono, fontSize: 12 }}>
          {error}
        </Alert>
      )}
      {report && (
        <Box sx={{ opacity: running ? 0.45 : 1 }} aria-busy={running}>
          <ReportView report={report} />
        </Box>
      )}
    </Box>
  );
}

function WindowFields(props: {
  label: string;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  ariaPrefix: string;
}): ReactElement {
  return (
    <Stack gap={0.5}>
      <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: '0.08em' }}>
        {props.label.toUpperCase()}
      </Typography>
      <Stack direction="row" gap={1} alignItems="center">
        <TextField
          type="datetime-local"
          value={props.from}
          onChange={(e) => props.onFrom(e.target.value)}
          size="small"
          inputProps={{ step: 1, 'aria-label': `${props.ariaPrefix} from` }}
          sx={{ '& input': { ...mono, fontSize: 12 } }}
        />
        <Typography color="text.secondary">→</Typography>
        <TextField
          type="datetime-local"
          value={props.to}
          onChange={(e) => props.onTo(e.target.value)}
          size="small"
          inputProps={{ step: 1, 'aria-label': `${props.ariaPrefix} to` }}
          sx={{ '& input': { ...mono, fontSize: 12 } }}
        />
      </Stack>
    </Stack>
  );
}

// ─── report rendering ───────────────────────────────────────────────────

const KIND_GROUPS: Array<{ kind: DeltaKind; title: string }> = [
  { kind: 'New', title: 'New in incident' },
  { kind: 'Absent', title: 'Absent in incident' },
  { kind: 'Changed', title: 'Changed rate' },
];

function ReportView({ report }: { report: DiffReport }): ReactElement {
  const match = MATCH_EXPLAIN[report.template_match];
  return (
    <Box sx={{ ...card, mt: 2 }} data-testid="diff-report">
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {report.service}
        </Typography>
        <Chip
          size="small"
          label={`baseline ${report.baseline_event_count.toLocaleString()} ev`}
        />
        <Chip
          size="small"
          label={`incident ${report.incident_event_count.toLocaleString()} ev`}
        />
        {/* Honesty rule (standard 3): match fidelity is always visible. */}
        <Tooltip title={match.explain}>
          <Chip
            size="small"
            color="primary"
            variant="outlined"
            label={match.label}
            data-testid="template-match-chip"
          />
        </Tooltip>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={mono} display="block">
        baseline {tsPretty(report.baseline_window[0])} → {tsPretty(report.baseline_window[1])} ·
        incident {tsPretty(report.incident_window[0])} → {tsPretty(report.incident_window[1])} UTC
      </Typography>
      {/* This view always requests per-event normalization (per_unit_time
          unset) — say so instead of leaving "rate" ambiguous. The unit
          matters twice over now that rates render as a percentage: the
          percentage is OF THE WINDOW'S EVENTS, not of the baseline rate. */}
      <Typography variant="caption" color="text.secondary" display="block">
        rates are per-event (count ÷ window events), shown as % of that window&apos;s events; Δ bars share one scale
        within each section
      </Typography>

      {report.notes.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1.5 }} data-testid="diff-notes">
          {report.notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </Alert>
      )}

      {KIND_GROUPS.map(({ kind, title }) => {
        const rows = report.template_deltas.filter((d) => d.kind === kind);
        // Biggest movers first: a ranked list is the point of the Δ column,
        // and the section's own largest |Δ| is the bar scale.
        const ranked = [...rows].sort((a, b) => Math.abs(b.rate_delta) - Math.abs(a.rate_delta));
        const scale = maxAbs(ranked.map((d) => d.rate_delta));
        return (
          <ReportSection key={kind} title={`Templates — ${title}`}>
            {ranked.length === 0 ? (
              <NoChange />
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <Th>Template</Th>
                    <Th>Baseline rate</Th>
                    <Th>Incident rate</Th>
                    <Th>Δ rate</Th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((d, i) => (
                    <tr key={i}>
                      <Td mono title={templateLabel(d)}>
                        {templateLabel(d).slice(0, 90)}
                      </Td>
                      <Td mono>{fmtRate(d.baseline_rate)}</Td>
                      <Td mono>{fmtRate(d.incident_rate)}</Td>
                      <DeltaCell value={d.rate_delta} scale={scale} />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ReportSection>
        );
      })}

      <ReportSection title="Latency / numeric quantile shifts">
        {report.quantile_shifts.length === 0 ? (
          <NoChange />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Attribute</Th>
                <Th>p50 →</Th>
                <Th>p95 →</Th>
                <Th>p99 →</Th>
              </tr>
            </thead>
            <tbody>
              {report.quantile_shifts.map((q, i) => (
                <tr key={i}>
                  <Td mono>{q.attribute}</Td>
                  {/* Absolute units, not percentages: these sit beside the
                      raw quantiles they moved between. */}
                  <Td mono>
                    {q.baseline_p50.toFixed(1)} → {q.incident_p50.toFixed(1)} (
                    {fmtNumDelta(q.p50_delta)})
                  </Td>
                  <Td mono>
                    {q.baseline_p95.toFixed(1)} → {q.incident_p95.toFixed(1)} (
                    {fmtNumDelta(q.p95_delta)})
                  </Td>
                  <Td mono>
                    {q.baseline_p99.toFixed(1)} → {q.incident_p99.toFixed(1)} (
                    {fmtNumDelta(q.p99_delta)})
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ReportSection>

      <ReportSection title="Dimension deltas">
        {report.dimension_deltas.length === 0 ? (
          <NoChange />
        ) : (
          report.dimension_deltas.map((d, i) =>
            'Sketched' in d ? (
              <Typography key={i} variant="body2" color="text.secondary" sx={{ my: 0.5 }}>
                <Box component="span" sx={mono}>
                  {d.Sketched.attribute}
                </Box>{' '}
                — sketched mode: values not enumerable; movement shows in cardinality shifts.
              </Typography>
            ) : (
              <DimensionTable key={i} attribute={d.Full.attribute} values={d.Full.values} />
            )
          )
        )}
      </ReportSection>

      <ReportSection title="Cardinality shifts">
        {report.cardinality_shifts.length === 0 ? (
          <NoChange />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Dimension</Th>
                <Th>Baseline distinct</Th>
                <Th>Incident distinct</Th>
                <Th>Δ</Th>
              </tr>
            </thead>
            <tbody>
              {report.cardinality_shifts.map((c, i) => (
                <tr key={i}>
                  <Td mono>{c.attribute}</Td>
                  <Td mono>{c.baseline_distinct.toLocaleString()}</Td>
                  <Td mono>{c.incident_distinct.toLocaleString()}</Td>
                  <Td mono>
                    {c.distinct_delta >= 0 ? `+${c.distinct_delta}` : `${c.distinct_delta}`}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ReportSection>

      {report.crosstab_deltas && report.crosstab_deltas.length > 0 && (
        <ReportSection title="Cross-tab churn">
          <table style={tableStyle} data-testid="crosstab-deltas">
            <thead>
              <tr>
                <Th>Pair</Th>
                <Th>Baseline total</Th>
                <Th>Incident total</Th>
                <Th>Churn (L1, 0–2)</Th>
                <Th>Cells</Th>
              </tr>
            </thead>
            <tbody>
              {report.crosstab_deltas.map((d, i) => (
                <tr key={i}>
                  <Td mono>
                    {d.row_axis} × {d.col_axis}
                  </Td>
                  <Td mono>{d.baseline_total.toLocaleString()}</Td>
                  <Td mono>{d.incident_total.toLocaleString()}</Td>
                  <Td mono>
                    {d.shape_mismatch ? 'shape mismatch — totals only' : d.rate_l1_delta.toFixed(4)}
                  </Td>
                  <Td mono>{d.cells_compared.toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          <Typography variant="caption" color="text.secondary">
            Count-Min churn is conservative (cells never under-count): it measures distribution
            movement, not exact counts.
          </Typography>
        </ReportSection>
      )}
    </Box>
  );
}

function DimensionTable(props: { attribute: string; values: DimValueDelta[] }): ReactElement {
  const ranked = [...props.values].sort((a, b) => Math.abs(b.rate_delta) - Math.abs(a.rate_delta));
  const scale = maxAbs(ranked.map((v) => v.rate_delta));
  return (
    <Box sx={{ my: 1 }}>
      <Typography variant="caption" sx={mono} color="text.secondary">
        {props.attribute}
      </Typography>
      <table style={tableStyle}>
        <thead>
          <tr>
            <Th>Value</Th>
            <Th>Baseline rate</Th>
            <Th>Incident rate</Th>
            <Th>Δ rate</Th>
            <Th>Kind</Th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((v, j) => (
            <tr key={j}>
              <Td mono>{v.value}</Td>
              <Td mono>{fmtRate(v.baseline_rate)}</Td>
              <Td mono>{fmtRate(v.incident_rate)}</Td>
              <DeltaCell value={v.rate_delta} scale={scale} />
              <Td>{v.kind}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  );
}

/**
 * The Δ column: the number, plus a bar on a scale shared by every row in the
 * section. The number is what you quote; the bar is what makes the ranking
 * readable without reading any of the numbers — which is the actual
 * complaint behind U13.
 *
 * The bar diverges from a centre line so sign is a DIRECTION, not a colour
 * you have to decode, and the two colours are warning/info rather than
 * red/green: a rate that collapsed is not "good news", and a chart must not
 * imply it is.
 */
function DeltaCell({ value, scale }: { value: number; scale: number }): ReactElement {
  const frac = scale > 0 && Number.isFinite(value) ? Math.min(1, Math.abs(value) / scale) : 0;
  const up = value > 0;
  return (
    <Td mono>
      <Stack direction="row" gap={1} alignItems="center">
        <Box component="span" sx={{ minWidth: 78, textAlign: 'right' }}>
          {fmtDelta(value)}
        </Box>
        <Box
          aria-hidden
          data-testid="delta-bar"
          sx={{
            position: 'relative',
            width: 72,
            height: 6,
            flexShrink: 0,
            borderRadius: 3,
            backgroundColor: 'rgba(127,127,127,0.15)',
          }}
        >
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              [up ? 'left' : 'right']: '50%',
              width: `${frac * 50}%`,
              borderRadius: 3,
              backgroundColor: up ? 'warning.main' : 'info.main',
            }}
          />
        </Box>
      </Stack>
    </Td>
  );
}

function ReportSection(props: { title: string; children: React.ReactNode }): ReactElement {
  return (
    <Box sx={{ mt: 2.5 }}>
      <Typography
        variant="overline"
        sx={{ letterSpacing: '0.1em', opacity: 0.7 }}
        display="block"
      >
        {props.title}
      </Typography>
      {props.children}
    </Box>
  );
}

function NoChange(): ReactElement {
  return (
    <Typography variant="body2" color="text.secondary">
      no change
    </Typography>
  );
}

const tableStyle: React.CSSProperties = { borderCollapse: 'collapse', width: '100%' };

function Th(props: { children: React.ReactNode }): ReactElement {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '5px 8px',
        borderBottom: '1px solid rgba(127,127,127,0.3)',
        fontWeight: 600,
        fontSize: 12,
      }}
    >
      {props.children}
    </th>
  );
}

function Td(props: {
  children: React.ReactNode;
  mono?: boolean;
  title?: string;
}): ReactElement {
  return (
    <td
      title={props.title}
      style={{
        padding: '3px 8px',
        borderBottom: '1px solid rgba(127,127,127,0.15)',
        fontFamily: props.mono ? '"JetBrains Mono", monospace' : undefined,
        whiteSpace: 'nowrap',
        fontSize: 12,
      }}
    >
      {props.children}
    </td>
  );
}

export default InvestigateView;
