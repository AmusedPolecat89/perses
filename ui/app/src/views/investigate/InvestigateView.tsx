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

import { ReactElement, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

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

type DimensionDelta =
  | { Full: { attribute: string; values: DimValueDelta[] } }
  | { Sketched: { attribute: string } };

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

function nsToLocalInput(ns: number): string {
  const d = new Date(Math.floor(ns / NS_PER_MS));
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

function localInputToNs(v: string): number | null {
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms * NS_PER_MS : null;
}

function fmtRate(r: number): string {
  if (r === 0) return '0';
  if (Math.abs(r) < 0.001) return r.toExponential(2);
  return r.toFixed(4);
}

function fmtDelta(r: number): string {
  const s = fmtRate(Math.abs(r));
  return r >= 0 ? `+${s}` : `-${s}`;
}

function tsPretty(ns: number): string {
  return new Date(ns / 1e6).toISOString().replace('T', ' ').slice(0, 19);
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
  const nowNs = useRef(Date.now() * NS_PER_MS).current;

  const [service, setService] = useState('svc-000');
  const [incidentFrom, setIncidentFrom] = useState(nsToLocalInput(nowNs - HOUR_MS * NS_PER_MS));
  const [incidentTo, setIncidentTo] = useState(nsToLocalInput(nowNs));
  const [baselineFrom, setBaselineFrom] = useState(
    nsToLocalInput(nowNs - (HOUR_MS + DAY_MS) * NS_PER_MS)
  );
  const [baselineTo, setBaselineTo] = useState(nsToLocalInput(nowNs - DAY_MS * NS_PER_MS));

  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<DiffReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const bounds = {
    baseline_from_ns: localInputToNs(baselineFrom),
    baseline_to_ns: localInputToNs(baselineTo),
    incident_from_ns: localInputToNs(incidentFrom),
    incident_to_ns: localInputToNs(incidentTo),
  };
  const invalid =
    service.trim() === '' ||
    Object.values(bounds).some((v) => v === null) ||
    (bounds.baseline_from_ns as number) >= (bounds.baseline_to_ns as number) ||
    (bounds.incident_from_ns as number) >= (bounds.incident_to_ns as number);

  const suggestBaseline = (): void => {
    const f = localInputToNs(incidentFrom);
    const t = localInputToNs(incidentTo);
    if (f === null || t === null) return;
    setBaselineFrom(nsToLocalInput(f - DAY_MS * NS_PER_MS));
    setBaselineTo(nsToLocalInput(t - DAY_MS * NS_PER_MS));
  };

  const run = async (): Promise<void> => {
    if (invalid) return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    // Wedge rule: the caller's abort AND a hard timeout, whichever first
    // (the app's TS lib target predates AbortSignal.any — manual bridge).
    const timeout = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const r = await fetch(`${API}/v1/diff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: service.trim(), ...bounds }),
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      if (!ctl.signal.aborted) setReport((await r.json()) as DiffReport);
    } catch (e) {
      if (!ctl.signal.aborted) setError(String(e));
    } finally {
      clearTimeout(timeout);
      if (abortRef.current === ctl) setRunning(false);
    }
  };

  const cancel = (): void => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const emptyWindow = error !== null && /404|empty window/i.test(error);

  return (
    <Box sx={{ padding: 3, maxWidth: 1200, margin: '0 auto' }}>
      <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
        Investigate
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        Differential forensics: pick a broken window and a healthy baseline, hit diff. The
        comparison runs over the summary sketches in memory — no raw scan, rate-normalized so
        window sizes don&apos;t have to match.
      </Typography>

      <Box sx={card}>
        <Stack direction="row" gap={2} flexWrap="wrap" alignItems="flex-end">
          <TextField
            label="Service"
            value={service}
            onChange={(e) => setService(e.target.value)}
            size="small"
            slotProps={{ input: { sx: { ...mono, fontSize: 13 } } }}
          />
          <WindowFields
            label="Baseline (healthy)"
            from={baselineFrom}
            to={baselineTo}
            onFrom={setBaselineFrom}
            onTo={setBaselineTo}
            ariaPrefix="Baseline"
          />
          <WindowFields
            label="Incident (broken)"
            from={incidentFrom}
            to={incidentTo}
            onFrom={setIncidentFrom}
            onTo={setIncidentTo}
            ariaPrefix="Incident"
          />
        </Stack>
        <Stack direction="row" gap={1.5} alignItems="center" sx={{ mt: 2 }}>
          <Button variant="contained" onClick={run} disabled={running || invalid}>
            Run diff
          </Button>
          <Button variant="outlined" size="small" onClick={suggestBaseline} disabled={running}>
            Suggest baseline (incident −24h)
          </Button>
          {running && (
            <>
              <CircularProgress size={18} />
              <Typography variant="caption" color="text.secondary">
                Running diff — cross-node diffs can take a while…
              </Typography>
              <Button size="small" color="inherit" onClick={cancel}>
                Cancel
              </Button>
            </>
          )}
          {invalid && !running && (
            <Typography variant="caption" color="warning.main">
              service + two valid windows (from &lt; to) required
            </Typography>
          )}
        </Stack>
      </Box>

      {emptyWindow && (
        <Alert severity="info" sx={{ mt: 2 }}>
          No summary data in one of the windows — widen a window or move the baseline to a period
          this node has data for.
        </Alert>
      )}
      {error && !emptyWindow && (
        <Alert severity="error" sx={{ mt: 2, ...mono, fontSize: 12 }}>
          {error}
        </Alert>
      )}
      {!running && !error && !report && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          No diff run yet — set the windows and hit Run diff.
        </Typography>
      )}

      {report && <ReportView report={report} />}
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
          unset) — say so instead of leaving "rate" ambiguous. */}
      <Typography variant="caption" color="text.secondary" display="block">
        rates are per-event (count ÷ window events)
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
        return (
          <ReportSection key={kind} title={`Templates — ${title}`}>
            {rows.length === 0 ? (
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
                  {rows.map((d, i) => (
                    <tr key={i}>
                      <Td mono title={templateLabel(d)}>
                        {templateLabel(d).slice(0, 90)}
                      </Td>
                      <Td mono>{fmtRate(d.baseline_rate)}</Td>
                      <Td mono>{fmtRate(d.incident_rate)}</Td>
                      <Td mono>{fmtDelta(d.rate_delta)}</Td>
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
                  <Td mono>
                    {q.baseline_p50.toFixed(1)} → {q.incident_p50.toFixed(1)} (
                    {fmtDelta(q.p50_delta)})
                  </Td>
                  <Td mono>
                    {q.baseline_p95.toFixed(1)} → {q.incident_p95.toFixed(1)} (
                    {fmtDelta(q.p95_delta)})
                  </Td>
                  <Td mono>
                    {q.baseline_p99.toFixed(1)} → {q.incident_p99.toFixed(1)} (
                    {fmtDelta(q.p99_delta)})
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
              <Box key={i} sx={{ my: 1 }}>
                <Typography variant="caption" sx={mono} color="text.secondary">
                  {d.Full.attribute}
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
                    {d.Full.values.map((v, j) => (
                      <tr key={j}>
                        <Td mono>{v.value}</Td>
                        <Td mono>{fmtRate(v.baseline_rate)}</Td>
                        <Td mono>{fmtRate(v.incident_rate)}</Td>
                        <Td mono>{fmtDelta(v.rate_delta)}</Td>
                        <Td>{v.kind}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
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
