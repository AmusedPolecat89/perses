// Copyright OBSESC Authors
//
// Explore — the dark-data surface. Two ways into the raw tier:
//
//   1. SQL over `raw_events` (micro-Athena): estimate-first — every query
//      gets a scan CEILING (files after index pruning, bytes, seconds, and
//      the scan slots it holds away from ingest) before it runs, and the
//      server's scan gate (HTTP 412 PRECONDITION_FAILED) renders as a
//      first-class confirmation, not an error. Nothing here is denominated
//      in money: scanning is free, OBSESC charges once, on ingest. "Keep
//      100%, query it like a table; the index is an accelerator, not a
//      gatekeeper."
//
//   2. Needle search: token → bloom-pruned (service, window) candidates →
//      click through to the verbatim raw event straight off Parquet.
//
// Fetches go straight to /obsesc-api (same pattern as use-node-stats):
// this surface must work on a fresh node before any datasource exists.

import { Fragment, ReactElement, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, TextField, Tooltip, Typography } from '@mui/material';
import ChevronRight from 'mdi-material-ui/ChevronRight';
import ChevronDown from 'mdi-material-ui/ChevronDown';
import { AsyncOpBar, AsyncOpStatus, asyncOpTriggerProps } from '../../components/progress/AsyncOp';
import { useAsyncOp } from '../../components/progress/useAsyncOp';
import { eitherSignal } from '../../utils/either-signal';
import { TimeRangeControl } from '../../components/TimeRangeControl';
import { useSharedTimeRange } from '../../hooks/use-shared-time-range';
import { ResolvedRange, isoSeconds, rangeKey, rangeLabel, resolveRange } from '../../model/time-range';
import {
  NeedleGroup,
  NeedleRun,
  NeedleSignal,
  SIGNAL_EXPLAIN,
  SIGNAL_LABEL,
  TokenWindow,
  groupNeedleWindows,
  signalTally,
  startHere,
} from './needle-ranking';

const API = '/obsesc-api';
const FETCH_TIMEOUT_MS = 60_000;

const mono = { fontFamily: '"JetBrains Mono", monospace' } as const;

const card = {
  borderRadius: 1.5,
  border: '1px solid',
  borderColor: 'background.border',
  backgroundColor: 'background.paper',
  padding: 2.5,
} as const;

// ─── The scan wire ─────────────────────────────────────────────────────
//
// Every byte field below is a RAW INTEGER and every ceiling is a ceiling,
// never a forecast — which is why no ceiling is ever rendered without an
// "up to". There is no money on this wire at all unless an operator
// configured an internal showback rate, and then `amount` and `label`
// travel as ONE unit.

type BoundKind = 'scan_bounded' | 'result_bounded' | 'unbounded';

/** How a query's `LIMIT` relates to the bytes the scan must actually read. */
interface ScanBound {
  kind: BoundKind;
  /** The LIMIT's fetch. `null` iff `kind === 'unbounded'`. */
  max_rows: number | null;
  offset: number;
  /** Non-null ONLY for `scan_bounded` (equals `max_rows + offset`). */
  per_shard_max_rows: number | null;
  /** True iff the scan itself can stop early. */
  early_exit: boolean;
  /** The pipeline breaker standing between the LIMIT and the scan. */
  blocked_by: string | null;
}

/** What the scan costs the write path — the honest answer to "what does
 *  this query cost me", now that the answer is not a price. */
interface IngestImpact {
  scan_slots: number;
  scan_slots_total: number;
  scan_slots_inflight: number;
  competes_with_ingest: boolean;
  note: string;
}

/** The ONE monetary object that can appear here, and only when an operator
 *  configured a rate to cross-charge their own tenants. `amount` without
 *  `label` misrepresents an internal allocation as an OBSESC price. */
interface Showback {
  amount: number;
  currency: string;
  rate_per_gib_scanned: number;
  basis: string;
  label: string;
}

/** `POST /v1/sql/estimate` 200, and the `estimate` member of both the run
 *  envelope and the gate response. */
interface ScanPreview {
  scope: 'raw_tier' | 'summary_tier';
  nodes: number;
  files_planned: number;
  /** `null` = UNKNOWN (no survivor carried an access plan), never zero. */
  rowgroups_planned: number | null;
  rowgroups_total: number | null;
  bytes_on_disk_ceiling: number;
  bytes_decompressed_ceiling: number;
  decompression_ratio: number;
  seconds_ceiling: number;
  bound: ScanBound;
  ingest_impact: IngestImpact;
  honesty: string;
  showback: Showback | null;
}

/** What the run actually consumed. `rows_scanned` is rows the Parquet scan
 *  DECODED — never "rows matched", which is a different and smaller number. */
interface ScanConsumption {
  scope: string;
  nodes: number;
  files_planned: number;
  files_touched: number;
  bytes_read: number;
  rows_scanned: number;
  rows_returned: number;
  elapsed_ms: number;
  rowgroups_pruned_statistics: number;
  rowgroups_pruned_bloom: number;
  rows_pruned_pushdown: number;
  rows_pruned_page_index: number;
  /** `false` ⇒ the totals are a FLOOR and the note must be rendered. */
  complete: boolean;
  note: string;
  showback: Showback | null;
}

/** `POST /v1/sql` 200. This used to be a bare row array. */
interface SqlRunResponse {
  rows: Array<Record<string, unknown>>;
  estimate: ScanPreview;
  consumption: ScanConsumption;
}

/** `POST /v1/sql` 412 — the precondition the caller supplied was not met. */
interface ScanGateResponse {
  rejected: boolean;
  reason: 'max_scan_bytes' | 'max_scan_seconds';
  limit: number;
  observed: number;
  estimate: ScanPreview;
  /** Server-composed and guaranteed money-free. Rendered verbatim. */
  message: string;
}

/** Probe transparency from the bit-sliced needle index (`NeedleStats`). */
interface NeedleStats {
  slabs_probed: number;
  manifests_probed: number;
  probe_bytes: number;
  covered_files: number;
  unindexed_files: number;
  listing_failed: boolean;
  manifest_budget_exhausted?: boolean;
}

interface RawEventJson {
  timestamp_ns: number;
  source: string;
  service: string;
  body_utf8?: string;
  body_base64?: string;
  attributes: Record<string, unknown>;
}

/** POST /v1/raw_grep — verbatim within-window grep for the searched token. */
interface RawGrepResponse {
  events: RawEventJson[];
  truncated: boolean;
  files_scanned: number;
  owners_failed?: number;
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/**
 * Binary units under the labels that actually match them. Mirrors the Rust
 * `fmt_bytes_binary` exactly — 0 decimals for B and KiB, 1 from MiB up — so
 * a server-composed gate message and a client-rendered chip can never
 * disagree. The predecessor of this function divided by 1024³ and labelled
 * the result "GB" while the server's dollars divided by 1e9: both halves
 * self-consistent, both labels wrong.
 */
function formatBytes(n: number): string {
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i >= 2 ? 1 : 0)} ${BYTE_UNITS[i]!}`;
}

/**
 * Mirrors the Rust `fmt_seconds_approx`. Coarse on purpose: the ceiling
 * rests on a fixed assumed throughput, so more digits would be false
 * precision dressed up as measurement.
 */
function formatSeconds(s: number): string {
  if (s < 90) return `~${s.toFixed(0)} s`;
  if (s < 5400) return `~${(s / 60).toFixed(0)} min`;
  return `~${(s / 3600).toFixed(1)} h`;
}

function tsPretty(ns: number): string {
  return new Date(ns / 1e6).toISOString().replace('T', ' ').slice(0, 19);
}

/// Render one SQL result cell readably:
///  - key/identifier columns (`template_key`, `idempotency_key`,
///    `similar_group`) pass through verbatim — they are opaque identifiers,
///    never timestamps and never hex-encoded text;
///  - binary columns (e.g. `body`) arrive hex-encoded from Arrow JSON —
///    decode to UTF-8 when the bytes are valid text;
///  - `*_ns` numeric columns pretty-print as timestamps.
function renderCell(column: string, value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  // template_keys() emits `template_key` as a u64 DECIMAL string (content
  // keys live in [2^63, 2^64), 19–20 digits) and `similar_group` as 16 hex
  // chars — both would trip the hex→UTF-8 heuristic below and a hypothetical
  // *_key_ns column the timestamp one. Keys render as the exact string.
  if (/(^|_)key$|^similar_group$/.test(column)) return s;
  if (column.endsWith('_ns')) {
    const n = Number(s);
    if (Number.isFinite(n) && n > 1e15) return tsPretty(n);
  }
  // Hex→UTF-8 only applies to STRING values: binary columns (`body`) arrive
  // hex-encoded as JSON strings, while Int64 columns (`events`, `windows`,
  // `vcol*_i64`…) arrive as JSON numbers — a pure-digit number like 50505050
  // would otherwise pass the hex regex and render as "PPPP".
  if (typeof value === 'string' && /^[0-9a-fA-F]+$/.test(s) && s.length >= 8 && s.length % 2 === 0) {
    try {
      const bytes = new Uint8Array(s.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // Only swap in the decode when it looks like text, not line noise.
      if (/^[\x20-\x7E\s]*$/.test(text)) return text;
    } catch {
      /* not UTF-8 — fall through to the raw value */
    }
  }
  return s;
}

async function apiFetch(path: string, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    // The caller's signal (supersede / Cancel / unmount) AND the hard
    // deadline, whichever fires first — the deadline applies even when a
    // caller signal is threaded.
    signal: eitherSignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)),
  });
}

// ─── SQL (micro-Athena) ────────────────────────────────────────────────

// Columns: timestamp_ns, source, service, body, idempotency_key, attributes.
// NOTE: row scans gather cluster-wide; aggregations (count/GROUP BY) run
// node-local today and the server rejects them distributed — cluster-wide
// aggregates live on the dashboards (summary tier). The presets stay
// distributed-safe.
const SQL_PRESETS: Array<{ label: string; sql: string }> = [
  {
    label: 'sample rows',
    sql: 'SELECT timestamp_ns, service, body FROM raw_events\nWHERE timestamp_ns >= {FROM_NS} AND timestamp_ns < {TO_NS}\nLIMIT 10',
  },
  {
    label: 'grep bodies',
    sql: "SELECT timestamp_ns, service, body FROM raw_events\nWHERE timestamp_ns >= {FROM_NS} AND timestamp_ns < {TO_NS}\n  AND body LIKE '%vault%'\nLIMIT 20",
  },
  {
    label: 'one service',
    sql: "SELECT timestamp_ns, body FROM raw_events\nWHERE timestamp_ns >= {FROM_NS} AND timestamp_ns < {TO_NS}\n  AND service = 'svc-b'\nLIMIT 20",
  },
  // Virtual columns (Lane H): template_keys(service, from_ns, to_ns) lists
  // every TemplateKey observed in the window (summary tier only — no raw
  // scan); template_events(service, template_key, from_ns, to_ns) re-matches
  // raw bodies against that template's pattern and exposes each <*> position
  // as vcol{i} (+ vcol{i}_i64 / vcol{i}_f64 typed companions). The key is a
  // u64 passed as a string literal (decimal or 0x-hex), exactly as
  // template_keys() prints it. Both are capped server-side at a 7-day window.
  {
    label: 'template keys',
    sql: "SELECT template_key, pattern, events, windows, wildcards, similar_group\nFROM template_keys('svc-000', {FROM_NS}, {TO_NS})\nLIMIT 50",
  },
  {
    label: 'template events',
    sql: "-- paste a template_key from the 'template keys' preset\nSELECT * FROM template_events('svc-000', '<template_key>', {FROM_NS}, {TO_NS})\nLIMIT 20",
  },
];

function materialise(sql: string, r: ResolvedRange): string {
  return sql.replaceAll('{FROM_NS}', String(r.fromNs)).replaceAll('{TO_NS}', String(r.toNs));
}

// ─── the time control writes the bounds (U10) ──────────────────────────
//
// `timestamp_ns >= 1785824670563000000` is not something a human can edit to
// mean "the last six hours", so the epoch-ns literals stop being something a
// human is expected to touch: the shared time control OWNS them and rewrites
// them in place. The rewrite is textual and deliberately narrow — it only
// claims the two positions where a nanosecond literal can only be a time
// bound:
//
//   1. a numeric comparison against the `timestamp_ns` column, and
//   2. the LAST TWO arguments of `template_keys(…)` / `template_events(…)`,
//      which are that function's `from_ns, to_ns` pair.
//
// A 13-digit floor keeps it off ordinary integers (a LIMIT, a status code, a
// port). A `template_key` literal is the same digit-class, which is why the
// virtual-column rule anchors on the closing paren: a quoted key is followed
// by a quote, never by the `, <digits>)` the pattern requires. Anything the
// rewrite does not recognise it does not touch, and it reports how many
// literals it changed so "nothing happened" is never silent.

/** ns-scale literal: 13+ digits (epoch ms ≈ 13, epoch ns ≈ 19). */
const NS_LITERAL = String.raw`\d{13,}`;
const TS_BOUND_RE = new RegExp(String.raw`(timestamp_ns\s*(?:>=|<=|>|<)\s*)(${NS_LITERAL})`, 'g');
const VCOL_WINDOW_RE = new RegExp(
  String.raw`(template_(?:keys|events)\s*\([^)]*?)(${NS_LITERAL})(\s*,\s*)(${NS_LITERAL})(\s*\))`,
  'g'
);

export interface SqlRewrite {
  sql: string;
  /** Literals actually changed. `0` ⇒ this query has no bound to own. */
  rewrote: number;
}

export function applyRangeToSql(sql: string, fromNs: number, toNs: number): SqlRewrite {
  let rewrote = 0;
  const swap = (was: string, now: string): string => {
    if (was !== now) rewrote += 1;
    return now;
  };
  let out = sql.replace(TS_BOUND_RE, (_m, lead: string, literal: string) => {
    // `>=` / `>` is the lower bound; `<=` / `<` the upper. The operator is
    // inside `lead`, so reading it back is exact rather than positional.
    const upper = lead.includes('<');
    return lead + swap(literal, String(upper ? toNs : fromNs));
  });
  out = out.replace(
    VCOL_WINDOW_RE,
    (_m, lead: string, from: string, sep: string, to: string, tail: string) =>
      lead + swap(from, String(fromNs)) + sep + swap(to, String(toNs)) + tail
  );
  return { sql: out, rewrote };
}

/** Run's result: the envelope, OR the 412 scan gate — which is a product
 *  feature, not an error. */
interface SqlRunResult {
  run: SqlRunResponse | null;
  gate: ScanGateResponse | null;
}

/**
 * The bound chip, per the wire contract. `unbounded` earns no chip: there is
 * nothing to qualify, and an empty qualifier reads as a claim.
 *
 * `scan_bounded` and `result_bounded` are NOT the same fact wearing two
 * names — `SELECT … ORDER BY ts LIMIT 10` returns ten rows and reads every
 * byte, so saying "row-limited" there would be a new honesty defect in the
 * opposite direction from the one this lane fixes.
 */
function boundChipLabel(b: ScanBound): string | null {
  if (typeof b.max_rows !== 'number') return null;
  const rows = b.max_rows.toLocaleString();
  if (b.kind === 'scan_bounded') return `row-limited to ${rows} — early exit may read far less`;
  if (b.kind === 'result_bounded') {
    return `returns ${rows} rows, but ${b.blocked_by ?? 'a pipeline breaker'} forces a full scan`;
  }
  return null;
}

/**
 * `null` rowgroup counts mean UNKNOWN — no survivor carried a signature
 * access plan — and unknown is never rendered as zero. The chip earns its
 * pixels only when the plan actually skips something.
 */
function rowgroupChipLabel(p: ScanPreview): string | null {
  const planned = p.rowgroups_planned;
  const total = p.rowgroups_total;
  if (typeof planned !== 'number' || typeof total !== 'number' || planned >= total) return null;
  return `${(total - planned).toLocaleString()} of ${total.toLocaleString()} rowgroups signature-skipped`;
}

/** `amount` and `label` are one unit. Rendering the number alone would turn
 *  an operator's internal allocation into an OBSESC price. */
function showbackChipLabel(s: Showback): string {
  return `${s.amount.toFixed(2)} ${s.currency} · ${s.label}`;
}

/**
 * The ceiling, in the only denominations that are true: files, bytes, time,
 * and the ingest headroom the scan holds. No coloured price chip, because
 * there is no price — the two notes underneath are what replaced it.
 */
function ScanCeiling({ preview }: { preview: ScanPreview }): ReactElement {
  const bound = boundChipLabel(preview.bound);
  const rowgroups = rowgroupChipLabel(preview);
  const impact = preview.ingest_impact;
  return (
    <Box sx={{ mt: 0.5 }} data-testid="scan-ceiling">
      <Stack direction="row" gap={1} flexWrap="wrap">
        <Chip size="small" label={`${preview.files_planned.toLocaleString()} files after pruning`} />
        <Chip size="small" label={`up to ${formatBytes(preview.bytes_on_disk_ceiling)} on disk`} />
        <Chip size="small" label={`up to ${formatBytes(preview.bytes_decompressed_ceiling)} decompressed`} />
        <Chip size="small" label={`up to ${formatSeconds(preview.seconds_ceiling)}`} />
        {rowgroups !== null && <Chip size="small" variant="outlined" label={rowgroups} />}
        {bound !== null && <Chip size="small" variant="outlined" label={bound} data-testid="scan-bound-chip" />}
        <Chip size="small" variant="outlined" label={`${impact.scan_slots} of ${impact.scan_slots_total} scan slots`} />
        {/* A currency symbol renders ONLY when the operator configured a
            showback rate. Absent (the default) means no monetary field at
            all — not a zero, and not a blank. */}
        {preview.showback && (
          <Chip
            size="small"
            variant="outlined"
            data-testid="scan-showback"
            label={showbackChipLabel(preview.showback)}
          />
        )}
      </Stack>
      {/* The ingest-headroom sentence stands exactly where the price tag
          used to. It is the honest answer to "what does this cost me": not
          dollars, but scan slots held away from the write path. */}
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 0.75 }}
        data-testid="scan-ingest-impact"
      >
        {impact.note}
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 0.5 }}
        data-testid="scan-honesty"
      >
        {preview.honesty}
      </Typography>
    </Box>
  );
}

/**
 * Estimated-vs-actual — the payoff. The ceiling was always going to look
 * enormous; standing what the run ACTUALLY read next to it is what turns
 * that from a credibility problem into a demonstration of how hard the
 * index pruned.
 */
function ScanActuals({ run }: { run: SqlRunResponse }): ReactElement {
  const est = run.estimate;
  const c = run.consumption;
  const headline =
    `estimated up to ${formatBytes(est.bytes_on_disk_ceiling)} · ` +
    `actually read ${formatBytes(c.bytes_read)} across ` +
    `${c.files_touched.toLocaleString()} of ${c.files_planned.toLocaleString()} files`;
  // "rows scanned", never "rows matched": these are rows the Parquet scan
  // DECODED, before the filter above it re-applied the full predicate.
  const detail =
    `${c.rows_scanned.toLocaleString()} rows scanned → ${c.rows_returned.toLocaleString()} returned · ` +
    `${(c.elapsed_ms / 1000).toFixed(1)} s${c.nodes > 1 ? ` · ${c.nodes} nodes` : ''}`;
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }} data-testid="scan-actuals">
        {headline}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} data-testid="scan-actuals-rows">
        {detail}
      </Typography>
      {c.showback && (
        <Chip
          size="small"
          variant="outlined"
          sx={{ mt: 0.75 }}
          data-testid="scan-actuals-showback"
          label={showbackChipLabel(c.showback)}
        />
      )}
      {c.complete ? (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 0.5 }}
          data-testid="scan-consumption-note"
        >
          {c.note}
        </Typography>
      ) : (
        // Non-dismissable by construction (no onClose): an incomplete total
        // that can be closed is an incomplete total that gets quoted.
        <Alert severity="warning" sx={{ mt: 1 }} data-testid="scan-incomplete">
          At least one scan reported no metrics, so the totals above are a FLOOR, not the whole story. {c.note}
        </Alert>
      )}
    </Box>
  );
}

function SqlSection(): ReactElement {
  // U10/U11: the shared range OWNS the epoch-ns bounds in this box. It is
  // resolved once per range change (not per render) so the text does not
  // churn under the cursor while the operator is editing it.
  const { range } = useSharedTimeRange();
  const rangeK = rangeKey(range);
  const [sql, setSql] = useState(() => materialise(SQL_PRESETS[0]!.sql, resolveRange(range, Date.now())));
  const [lastRewrite, setLastRewrite] = useState<number | null>(null);
  const appliedRange = useRef(rangeK);
  // The editor's live text, readable from an effect without making that
  // effect fire on every keystroke.
  const sqlRef = useRef(sql);
  sqlRef.current = sql;

  const reapplyRange = (): void => {
    const r = resolveRange(range, Date.now());
    const next = applyRangeToSql(sqlRef.current, r.fromNs, r.toNs);
    setSql(next.sql);
    setLastRewrite(next.rewrote);
  };

  useEffect(() => {
    if (appliedRange.current === rangeK) return;
    appliedRange.current = rangeK;
    reapplyRange();
    // `range` is fully described by `rangeK`; depending on the object itself
    // would re-run this on every render of a relative range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeK]);

  // TWO independent operations, TWO hook instances. The single shared
  // `busy` token that used to live here is what swallowed Run clicks while
  // an estimate was in flight (U5): Estimate's own state must never be able
  // to disable Run, and neither control is disabled by its own work either.
  const estimate = useAsyncOp<ScanPreview, [string]>(
    async (ctx, text) => {
      const r = await apiFetch(
        '/v1/sql/estimate',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // `sql` only: the estimate has nothing to gate, so `confirm` and
          // the `max_*` ceilings are not accepted there and sending them
          // would advertise controls that do nothing.
          body: JSON.stringify({ sql: text }),
        },
        ctx.signal
      );
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const parsed = (await r.json()) as Partial<ScanPreview> | null;
      if (typeof parsed?.bytes_on_disk_ceiling !== 'number' || !parsed.bound || !parsed.ingest_impact) {
        // Loud schema drift, same reason as the run envelope: rendering a
        // half-shaped preview would put NaN where a ceiling belongs.
        throw new Error(
          'POST /v1/sql/estimate did not return a ScanPreview — this node predates the scan redenomination.'
        );
      }
      const preview = parsed as ScanPreview;
      return {
        data: preview,
        receipt: `${preview.files_planned.toLocaleString()} files after pruning · up to ${formatBytes(
          preview.bytes_on_disk_ceiling
        )} on disk`,
      };
    },
    { label: 'Estimate', timeoutMs: FETCH_TIMEOUT_MS }
  );

  const query = useAsyncOp<SqlRunResult, [string, boolean]>(
    async (ctx, text, confirm) => {
      const r = await apiFetch(
        '/v1/sql',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // NO ceilings on the first Run. A stock node has no gate; a
          // configured one gates on ITS OWN limits, and the operator's
          // answer to that is `confirm`, not a number this UI invented.
          body: JSON.stringify(confirm ? { sql: text, confirm: true } : { sql: text }),
        },
        ctx.signal
      );
      if (r.status === 412) {
        // The scan gate resolves as DATA, not an error: the run did exactly
        // what it was supposed to do. (This was 402 PAYMENT_REQUIRED before
        // the redenomination — the wrong signal under toll-once pricing,
        // and invisible to a type checker, so it is pinned by a test.)
        const gated = (await r.json()) as Partial<ScanGateResponse> | null;
        if (!gated?.estimate || typeof gated.message !== 'string') {
          throw new Error('412 from /v1/sql without a ScanGateResponse body — something between here and the node.');
        }
        return { data: { run: null, gate: gated as ScanGateResponse }, receipt: 'stopped by the scan gate' };
      }
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const parsed = (await r.json()) as Partial<SqlRunResponse> | null;
      if (!Array.isArray(parsed?.rows) || !parsed?.estimate || !parsed?.consumption) {
        // Loud schema drift. /v1/sql used to answer with a BARE row array;
        // silently rendering nothing would be indistinguishable from an
        // empty result set, which is the one failure mode this surface
        // cannot afford.
        throw new Error(
          'POST /v1/sql did not return the {rows, estimate, consumption} envelope — this node predates the scan redenomination.'
        );
      }
      const body = parsed as SqlRunResponse;
      const c = body.consumption;
      return {
        data: { run: body, gate: null },
        receipt: `${body.rows.length} row${body.rows.length === 1 ? '' : 's'} · read ${formatBytes(
          c.bytes_read
        )} across ${c.files_touched.toLocaleString()} of ${c.files_planned.toLocaleString()} files`,
      };
    },
    { label: 'Run', timeoutMs: FETCH_TIMEOUT_MS }
  );

  // What the caption states the query's window IS. One clock reading, so the
  // two ends of the sentence cannot straddle a millisecond boundary.
  const shown = resolveRange(range, Date.now());

  const run = query.state.data?.run ?? null;
  const gate = query.state.data?.gate ?? null;
  const rows = run?.rows ?? null;
  // The chips prefer an explicit Estimate — the operator asked for that
  // one — and otherwise fall back to the preview the run (or the gate)
  // carried, so a bare Run still shows the ceiling it was measured against.
  const preview = estimate.state.data ?? run?.estimate ?? gate?.estimate ?? null;
  const columns = useMemo(() => (rows?.length ? Object.keys(rows[0]!) : []), [rows]);

  // One bar per region (two stacked bars would reflow); the status row
  // below names both operations.
  const regionBar = query.state.phase === 'running' ? query.state : estimate.state;

  const reset = (): void => {
    estimate.reset();
    query.reset();
  };

  return (
    <Box sx={card}>
      <AsyncOpBar state={regionBar} testId="asyncop-bar-sql" />
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        SQL over the raw tier
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Every event you ever ingested is an open Parquet table (<code>raw_events</code>). The summary index prunes the
        scan. <strong>Scanning is free — you paid on the way in;</strong> the estimate is a <em>ceiling</em> on what
        this query would read and how long it holds scan capacity away from ingest. Row scans gather cluster-wide;
        aggregates (<code>count</code>/<code>GROUP BY</code>) are node-local today — use the dashboards for cluster-wide
        aggregates.
      </Typography>
      <Stack direction="row" gap={1} sx={{ mb: 1 }} flexWrap="wrap">
        {SQL_PRESETS.map((p) => (
          <Chip
            key={p.label}
            label={p.label}
            size="small"
            variant="outlined"
            onClick={() => {
              setSql(materialise(p.sql, resolveRange(range, Date.now())));
              setLastRewrite(null);
              reset();
            }}
          />
        ))}
      </Stack>
      <TextField
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        multiline
        minRows={3}
        maxRows={10}
        fullWidth
        slotProps={{ input: { sx: { ...mono, fontSize: 13 } } }}
        aria-label="SQL query"
      />
      {/* The epoch-ns literals above, in words. Nobody can check
          `1785824670563000000` by eye; this is the line that makes the
          query's window legible (U10). */}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }} data-testid="sql-window">
        Time range writes the <code>timestamp_ns</code> bounds — {rangeLabel(range)}: {isoSeconds(shown.fromMs)} →{' '}
        {isoSeconds(shown.toMs)} UTC
        {lastRewrite === 0 && ' · nothing to rewrite: this query has no timestamp_ns bound'}
        {lastRewrite !== null && lastRewrite > 0 && ` · rewrote ${lastRewrite} bound${lastRewrite === 1 ? '' : 's'}`}
      </Typography>
      {/* flexWrap: the row must never squeeze its own buttons narrower while
          the pointer is travelling toward them — a click lost to layout
          shift has the same "nothing happened" signature as U5. */}
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap" sx={{ mt: 1.5 }}>
        {/* data-testid, NOT aria-label: the visible label deliberately changes
            with phase and a screen reader should announce that change, so the
            accessible name must stay the live text. Tests need a handle that
            does not move — an exact-name locator goes stale the instant the
            label flips, which reads as "the control vanished". */}
        <Button
          variant="outlined"
          data-testid="sql-estimate-btn"
          onClick={() => estimate.run(sql)}
          {...asyncOpTriggerProps(estimate.state)}
        >
          {estimate.state.phase === 'running' ? 'Estimating…' : 'Estimate'}
        </Button>
        <Button
          variant="contained"
          data-testid="sql-run-btn"
          onClick={() => query.run(sql, false)}
          {...asyncOpTriggerProps(query.state)}
        >
          {query.state.phase === 'running' ? 'Running…' : 'Run'}
        </Button>
        {/* The explicit escape hatch for a hand-edited query: re-resolve the
            shared range and stamp it back over the bounds. Reports the count
            so "it did nothing" is never left to inference. */}
        <Button variant="text" size="small" onClick={reapplyRange}>
          Reapply time range
        </Button>
      </Stack>
      {/* The reserved status slot: entering/leaving the running state costs
          zero layout, and the receipt persists until the next run — a click
          that failed to register leaves a stale receipt and no running
          state, which is instantly legible as "that did nothing". */}
      <Stack direction="row" gap={2.5} alignItems="center" flexWrap="wrap">
        <AsyncOpStatus
          id="sql-estimate"
          state={estimate.state}
          label="Estimate"
          runningHint="Pruning the summary index for a scan ceiling…"
          onCancel={estimate.cancel}
        />
        <AsyncOpStatus
          id="sql-run"
          state={query.state}
          label="Run"
          runningHint="Scanning the raw tier…"
          idleHint="Estimate first, or just run it."
          onCancel={query.cancel}
        />
      </Stack>
      {preview && <ScanCeiling preview={preview} />}
      {run && <ScanActuals run={run} />}

      {gate && (
        <Alert
          severity="warning"
          sx={{ mt: 1.5 }}
          data-testid="scan-gate"
          action={
            // Resend with `confirm: true` and NO ceilings — the operator is
            // acknowledging the node's own limit, not naming a new one.
            <Button color="inherit" size="small" onClick={() => query.run(sql, true)}>
              Confirm &amp; run (up to {formatBytes(gate.estimate.bytes_on_disk_ceiling)})
            </Button>
          }
        >
          Scan gate: {gate.message}
        </Alert>
      )}
      {estimate.state.error !== null && (
        <Alert severity="error" sx={{ mt: 1.5, ...mono, fontSize: 12 }}>
          {estimate.state.error}
        </Alert>
      )}
      {query.state.error !== null && (
        <Alert severity="error" sx={{ mt: 1.5, ...mono, fontSize: 12 }}>
          {query.state.error}
        </Alert>
      )}

      {rows && (
        // A re-run dims the previous table rather than blanking it for
        // several seconds — stale, but visibly stale.
        <Box
          sx={{ mt: 2, overflowX: 'auto', opacity: query.state.phase === 'running' ? 0.45 : 1 }}
          aria-busy={query.state.phase === 'running'}
        >
          <Typography variant="caption" color="text.secondary">
            {rows.length} row{rows.length === 1 ? '' : 's'}
            {query.state.phase === 'running' ? ' (previous run)' : ''}
          </Typography>
          <table style={{ borderCollapse: 'collapse', width: '100%' }} data-testid="sql-results">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} style={{ textAlign: 'left', padding: '4px 12px 4px 0', opacity: 0.6 }}>
                    <Typography variant="caption" sx={mono}>
                      {c}
                    </Typography>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((row, i) => (
                <tr key={i} style={{ borderTop: '1px solid rgba(128,128,128,0.15)' }}>
                  {columns.map((c) => (
                    <td key={c} style={{ padding: '4px 12px 4px 0', verticalAlign: 'top' }}>
                      <Typography variant="body2" sx={{ ...mono, fontSize: 12 }}>
                        {renderCell(c, row[c])}
                      </Typography>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 100 && (
            <Typography variant="caption" color="text.secondary">
              showing first 100 of {rows.length}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}

// ─── Needle search ─────────────────────────────────────────────────────

/** Wrap every occurrence of `token` in the body in a <mark>. */
function highlightToken(body: string, token: string): ReactNode {
  if (!token) return body;
  const parts = body.split(token);
  if (parts.length === 1) return body;
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push(<mark key={i}>{token}</mark>);
    out.push(part);
  });
  return out;
}

/** What one search resolved to — the token snapshot travels WITH the result. */
interface NeedleSearchResult {
  windows: TokenWindow[];
  /** Matching windows before any server-side truncation. */
  total: number;
  scanned: number;
  /** Windows the needle index removed as PROVABLY token-free. */
  prunedWindows: number;
  /** `null` = no needle assist ran; the ranking falls back to the blooms. */
  stats: NeedleStats | null;
  /** The token this window list was searched with — the drill greps for
   *  exactly this, so editing the input afterwards can't grep a different
   *  token, and a superseded search can't leave its token behind. */
  searchedToken: string;
}

/** Runs rendered per service before the group says "narrow it". */
const RUNS_PER_GROUP = 25;

/**
 * Expand everything only while everything still FITS. Past that the top
 * group is expanded and the rest stand as one-line summaries — which is the
 * difference between 4,056 rows and a page you can read.
 */
function expandsByDefault(groups: NeedleGroup[]): (index: number) => boolean {
  const totalRuns = groups.reduce((n, g) => n + g.runs.length, 0);
  const all = groups.length <= 5 && totalRuns <= RUNS_PER_GROUP;
  return (index: number) => all || index === 0;
}

function signalChipColor(signal: NeedleSignal): 'success' | 'primary' | 'warning' | 'default' {
  if (signal === 'corroborated') return 'success';
  if (signal === 'bloom-hit') return 'primary';
  if (signal === 'saturated') return 'warning';
  return 'default';
}

function SignalChip({ signal }: { signal: NeedleSignal }): ReactElement {
  return (
    <Tooltip title={SIGNAL_EXPLAIN[signal]}>
      <Chip
        size="small"
        variant="outlined"
        color={signalChipColor(signal)}
        label={SIGNAL_LABEL[signal]}
        data-testid="needle-signal-chip"
      />
    </Tooltip>
  );
}

/** `10:00:00 → 14:00:00` when the run stays inside one day; full stamps otherwise. */
function runSpan(run: NeedleRun): string {
  const from = tsPretty(run.startNs);
  const to = tsPretty(run.endNs);
  return from.slice(0, 10) === to.slice(0, 10) ? `${from} → ${to.slice(11)}` : `${from} → ${to}`;
}

/**
 * The verbatim answer, rendered INLINE under the row that asked for it (U9).
 * It used to render after the whole candidate list, so clicking row 11 of 50
 * put the answer below row 50 — off-screen, found only by pressing End.
 */
function DrillResult({
  state,
  grep,
  token,
}: {
  state: ReturnType<typeof useAsyncOp<RawGrepResponse, [NeedleRun, string]>>['state'];
  grep: RawGrepResponse | null;
  token: string;
}): ReactElement {
  return (
    <Box sx={{ pl: 2, pb: 1.5, borderLeft: '2px solid', borderColor: 'primary.main' }} data-testid="needle-drill-panel">
      <AsyncOpBar state={state} />
      {state.error !== null && (
        <Alert severity="error" sx={{ mt: 1, ...mono, fontSize: 12 }}>
          {state.error}
        </Alert>
      )}
      {grep && (grep.owners_failed ?? 0) > 0 && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {grep.owners_failed} owner node{grep.owners_failed === 1 ? '' : 's'} failed to answer — coverage is partial;
          matches below may be incomplete.
        </Alert>
      )}
      {grep && grep.events.length === 0 && grep.files_scanned === 0 && (
        <Alert severity="info" sx={{ mt: 1 }}>
          No raw files cover this window yet (still inside the flush window?).
        </Alert>
      )}
      {grep && grep.events.length === 0 && grep.files_scanned > 0 && (
        <Alert severity="info" sx={{ mt: 1 }} data-testid="needle-honest-miss">
          No verbatim match for &quot;{token}&quot; in this window — the bloom candidate was a false positive.
        </Alert>
      )}
      {grep && grep.events.length > 0 && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {grep.events.length} verbatim match{grep.events.length === 1 ? '' : 'es'}
            {grep.truncated ? ` — more exist, showing the first ${grep.events.length}` : ''} · {grep.files_scanned} raw
            file{grep.files_scanned === 1 ? '' : 's'} scanned
          </Typography>
          {grep.events.map((ev, i) => (
            <Box
              key={i}
              sx={{
                mt: 1,
                padding: 1.5,
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'background.border',
              }}
              data-testid="needle-raw-event"
            >
              <Typography variant="overline" color="text.secondary">
                Raw event · {ev.service} · {tsPretty(ev.timestamp_ns)} · via {ev.source}
              </Typography>
              <Typography component="pre" sx={{ ...mono, fontSize: 12, whiteSpace: 'pre-wrap', m: 0 }}>
                {ev.body_utf8 !== undefined
                  ? highlightToken(ev.body_utf8, token)
                  : `(binary body, base64) ${ev.body_base64 ?? ''}`}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * Everything the needle index will admit about its own probe. It is the
 * reason the ranking can claim anything at all, so when it did not run — or
 * ran degraded — the list says so instead of quietly ranking on nothing.
 */
function NeedleProbeNotes({ result }: { result: NeedleSearchResult }): ReactElement | null {
  const notes: string[] = [];
  if (result.prunedWindows > 0) {
    notes.push(
      `${result.prunedWindows.toLocaleString()} window${
        result.prunedWindows === 1 ? '' : 's'
      } removed by the needle index as provably token-free — they are not hidden, they are excluded.`
    );
  }
  if (result.stats === null) {
    notes.push(
      'No needle-index assist ran for this search (no raw tier/catalog, or the token is below the indexing floor), so ranking rests on the token blooms alone.'
    );
  } else {
    if (result.stats.listing_failed) {
      notes.push(
        'A store listing failed, so part of the range degraded to "not covered" — over-keep, never a false negative.'
      );
    }
    if (result.stats.manifest_budget_exhausted === true) {
      notes.push(
        'The manifest probe hit its byte budget; the files it could not read are kept as whole-file candidates. Build the day slabs to lift this.'
      );
    }
    if (result.stats.unindexed_files > 0) {
      notes.push(
        `${result.stats.unindexed_files.toLocaleString()} raw file${
          result.stats.unindexed_files === 1 ? '' : 's'
        } in range are not signature-covered (fresh or never compacted) — the index cannot corroborate those windows either way.`
      );
    }
  }
  if (notes.length === 0) return null;
  return (
    <Box sx={{ mt: 1 }} data-testid="needle-probe-notes">
      {notes.map((n, i) => (
        <Typography key={i} variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {n}
        </Typography>
      ))}
    </Box>
  );
}

function NeedleSection(): ReactElement {
  const [token, setToken] = useState('');
  const [service, setService] = useState('');
  // U11: no private Range dropdown here any more — the needle searches the
  // SAME window the SQL box, the dashboards and Investigate are looking at.
  const { range } = useSharedTimeRange();
  /** The run a drill is running against — for the per-row busy state. */
  const [drillTarget, setDrillTarget] = useState<NeedleRun | null>(null);
  /** Per-service expand overrides; `undefined` = whatever the default says. */
  const [expandOverride, setExpandOverride] = useState<Record<string, boolean>>({});

  // The hook's generation guard closes the stale-response race this search
  // used to have: two searches in flight resolved in ARRIVAL order, so a
  // slower older search overwrote the newer results.
  const search = useAsyncOp<NeedleSearchResult, [string, string, number, number]>(
    async (ctx, tok, svc, fromNs, toNs) => {
      const qs = new URLSearchParams({
        token: tok,
        from_ns: String(fromNs),
        to_ns: String(toNs),
      });
      if (svc) qs.set('service', svc);
      const r = await apiFetch(`/v1/search_tokens?${qs}`, undefined, ctx.signal);
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = (await r.json()) as {
        windows?: TokenWindow[];
        total?: number;
        scanned_files?: number;
        needle_pruned_windows?: number;
        needle?: NeedleStats | null;
      };
      if (!Array.isArray(d.windows)) {
        // Loud schema drift, same rule as the SQL envelope: an empty list is
        // a real and meaningful answer ("the blooms pruned everything"), so
        // a missing list must never be able to impersonate one.
        throw new Error('GET /v1/search_tokens did not return a `windows` array — this node is not one this UI knows.');
      }
      const windows = d.windows;
      return {
        data: {
          windows,
          total: typeof d.total === 'number' ? d.total : windows.length,
          scanned: d.scanned_files ?? 0,
          prunedWindows: d.needle_pruned_windows ?? 0,
          stats: d.needle ?? null,
          searchedToken: tok,
        },
        receipt: `${windows.length} candidate window${windows.length === 1 ? '' : 's'} · ${
          d.scanned_files ?? 0
        } summary files consulted`,
      };
    },
    { label: 'Search', timeoutMs: FETCH_TIMEOUT_MS }
  );

  // The drill used to have NO feedback at all for ~10 s of raw-tier grep.
  // It now greps a whole COLLAPSED RUN in one request: a run is contiguous
  // and single-service by construction, so [start, end) is one window as far
  // as /v1/raw_grep is concerned — 48 rows became one row and 48 potential
  // requests became one.
  const drill = useAsyncOp<RawGrepResponse, [NeedleRun, string]>(
    async (ctx, run, tok) => {
      const r = await apiFetch(
        '/v1/raw_grep',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            service: run.service,
            from_ns: run.startNs,
            to_ns: run.endNs,
            token: tok,
            limit: 5,
          }),
        },
        ctx.signal
      );
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const got = (await r.json()) as RawGrepResponse;
      return {
        data: got,
        receipt: `${got.events.length} verbatim match${got.events.length === 1 ? '' : 'es'} · ${
          got.files_scanned
        } raw file${got.files_scanned === 1 ? '' : 's'} scanned`,
      };
    },
    { label: 'Grep', timeoutMs: FETCH_TIMEOUT_MS }
  );

  const result = search.state.data;
  const windows = result?.windows ?? null;
  const searchedToken = result?.searchedToken ?? '';
  const grep = drill.state.data;
  const drilling = drill.state.phase === 'running';

  // Ranked, collapsed and grouped ONCE per result — the runs must keep their
  // identity across renders or `drillTarget === run` (the per-row busy state
  // and the inline result) would break on every keystroke.
  const groups = useMemo(() => groupNeedleWindows(windows ?? []), [windows]);
  const tally = useMemo(() => signalTally(windows ?? []), [windows]);
  const isDefaultExpanded = useMemo(() => expandsByDefault(groups), [groups]);
  const guidance = useMemo(() => startHere(groups), [groups]);

  // A new result set is a new page: previous expand choices described a
  // different list and must not survive into this one.
  useEffect(() => {
    setExpandOverride({});
    setDrillTarget(null);
  }, [result]);

  const onDrill = (run: NeedleRun): void => {
    // Re-entry on the SAME row is a no-op; a different row supersedes.
    if (drilling && drillTarget === run) return;
    setDrillTarget(run);
    drill.run(run, searchedToken);
  };

  const runSearch = (): void => {
    const r = resolveRange(range, Date.now());
    search.run(token, service, r.fromNs, r.toNs);
  };

  const tokenTooShort = token.length < 3;
  const regionBar = drilling ? drill.state : search.state;

  return (
    <Box sx={card}>
      <AsyncOpBar state={regionBar} testId="asyncop-bar-needle" />
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        Needle search
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Grep months of raw logs for one token (a request id, an IP, an error string). Token blooms prune to the
        candidate windows and the bit-sliced needle index corroborates them; the drill-down greps the window and shows
        only verbatim matches — a bloom false positive says so instead of showing an unrelated event.
      </Typography>
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        <TextField
          size="small"
          label="Token (≥ 3 chars)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          sx={{ minWidth: 260 }}
          slotProps={{ input: { sx: mono } }}
        />
        <TextField
          size="small"
          label="Service (optional)"
          value={service}
          onChange={(e) => setService(e.target.value)}
          sx={{ minWidth: 180 }}
          slotProps={{ input: { sx: mono } }}
        />
        {/* Blocked only by a PRECONDITION, never by in-flight work — and the
            reason is rendered next to it instead of left mute. data-testid for
            the same reason as Estimate/Run above: the label flips on click. */}
        <Button
          variant="contained"
          data-testid="needle-search-btn"
          onClick={runSearch}
          disabled={tokenTooShort}
          {...asyncOpTriggerProps(search.state)}
        >
          {search.state.phase === 'running' ? 'Searching…' : 'Search'}
        </Button>
        {tokenTooShort && (
          <Typography variant="caption" color="text.secondary">
            enter at least 3 characters to search
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          searching {rangeLabel(range)} — set above
        </Typography>
      </Stack>
      <Stack direction="row" gap={2.5} alignItems="center" flexWrap="wrap">
        <AsyncOpStatus
          id="needle-search"
          state={search.state}
          label="Search"
          runningHint="Probing token blooms across the summary tier…"
          onCancel={search.cancel}
        />
        <AsyncOpStatus
          id="needle-drill"
          state={drill.state}
          label="Grep"
          runningHint={
            drillTarget
              ? `Greping ${drillTarget.windows.toLocaleString()} window${
                  drillTarget.windows === 1 ? '' : 's'
                } · ${drillTarget.eventCount.toLocaleString()} events…`
              : 'Greping the window…'
          }
          onCancel={drill.cancel}
        />
      </Stack>

      {search.state.error !== null && (
        <Alert severity="error" sx={{ mt: 1.5, ...mono, fontSize: 12 }}>
          {search.state.error}
        </Alert>
      )}

      {result && (
        <Box sx={{ mt: 2, opacity: search.state.phase === 'running' ? 0.45 : 1 }}>
          {/* The headline: what the search found, said in the units that
              actually differ between rows. The old line said "N candidate
              windows" and nothing else, which is why 4,056 identical rows
              read as failure rather than as one saturated bloom. */}
          <Typography variant="body2" color="text.secondary" data-testid="needle-summary">
            {result.total.toLocaleString()} candidate window{result.total === 1 ? '' : 's'} across{' '}
            {groups.length.toLocaleString()} service{groups.length === 1 ? '' : 's'} · {result.scanned.toLocaleString()}{' '}
            summary files consulted
          </Typography>
          <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 0.75 }}>
            {(['corroborated', 'bloom-hit', 'no-bloom', 'saturated'] as NeedleSignal[])
              .filter((s) => tally[s] > 0)
              .map((s) => (
                <Tooltip key={s} title={SIGNAL_EXPLAIN[s]}>
                  <Chip
                    size="small"
                    variant="outlined"
                    color={signalChipColor(s)}
                    label={`${tally[s].toLocaleString()} ${SIGNAL_LABEL[s]}`}
                  />
                </Tooltip>
              ))}
          </Stack>
          {guidance !== null && (
            <Alert severity="info" sx={{ mt: 1.5 }} data-testid="needle-start-here">
              {guidance}
            </Alert>
          )}
          <NeedleProbeNotes result={result} />

          {groups.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              No window survived the blooms in this range — for a window that carries a bloom, that is a definite
              &quot;not here&quot;, not a maybe.
            </Typography>
          ) : (
            <Box sx={{ mt: 1.5 }}>
              {groups.map((group, gi) => {
                const open = expandOverride[group.service] ?? isDefaultExpanded(gi);
                return (
                  <Box
                    key={group.service}
                    sx={{ borderTop: '1px solid rgba(128,128,128,0.15)' }}
                    data-testid="needle-group"
                  >
                    <Stack
                      direction="row"
                      gap={1}
                      alignItems="center"
                      flexWrap="wrap"
                      sx={{ py: 0.75, cursor: 'pointer' }}
                      onClick={() => setExpandOverride((prev) => ({ ...prev, [group.service]: !open }))}
                      role="button"
                      aria-expanded={open}
                      data-testid="needle-group-header"
                    >
                      {open ? <ChevronDown fontSize="small" /> : <ChevronRight fontSize="small" />}
                      <Typography variant="body2" sx={{ ...mono, fontWeight: 600 }}>
                        {group.service}
                      </Typography>
                      <SignalChip signal={group.best} />
                      <Typography variant="caption" color="text.secondary">
                        {group.runs.length.toLocaleString()} run{group.runs.length === 1 ? '' : 's'} ·{' '}
                        {group.windowCount.toLocaleString()} window{group.windowCount === 1 ? '' : 's'} ·{' '}
                        {group.eventCount.toLocaleString()} events
                      </Typography>
                      {/* The move the operator made by hand on the live
                          drive — typing a service name cut 4,056 rows to 50
                          — is one click here. */}
                      <Chip
                        size="small"
                        variant="outlined"
                        label="only this service"
                        onClick={(e) => {
                          e.stopPropagation();
                          setService(group.service);
                        }}
                      />
                    </Stack>
                    {open && (
                      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                        <tbody>
                          {group.runs.slice(0, RUNS_PER_GROUP).map((run, i) => (
                            <Fragment key={`${run.startNs}:${i}`}>
                              <tr
                                onClick={() => onDrill(run)}
                                aria-busy={drilling && drillTarget === run}
                                data-testid="needle-window-row"
                                style={{
                                  borderTop: '1px solid rgba(128,128,128,0.08)',
                                  cursor: 'pointer',
                                }}
                                title="Grep this window for verbatim matches"
                              >
                                <td style={{ padding: '5px 12px 5px 24px' }}>
                                  <Typography variant="body2" sx={{ ...mono, fontSize: 12 }}>
                                    {runSpan(run)}
                                  </Typography>
                                </td>
                                <td style={{ padding: '5px 12px 5px 0' }}>
                                  <Typography variant="caption" color="text.secondary">
                                    {run.windows > 1 ? `${run.windows.toLocaleString()} contiguous windows · ` : ''}
                                    {run.eventCount.toLocaleString()} events
                                  </Typography>
                                </td>
                                <td style={{ padding: '5px 0' }}>
                                  <SignalChip signal={run.signal} />
                                </td>
                              </tr>
                              {/* U9: the answer belongs under the row that
                                  asked the question, not after the list. */}
                              {drillTarget === run && (
                                <tr>
                                  <td colSpan={3} style={{ padding: 0 }}>
                                    <DrillResult state={drill.state} grep={grep ?? null} token={searchedToken} />
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {open && group.runs.length > RUNS_PER_GROUP && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', pl: 3, pb: 1 }}>
                        showing the {RUNS_PER_GROUP} strongest of {group.runs.length.toLocaleString()} runs — narrow the
                        time range to see the rest
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

export default function ObsescExploreView(): ReactElement {
  return (
    <Box sx={{ padding: 3, maxWidth: 1280, mx: 'auto' }}>
      <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
        Explore
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
        The raw tier keeps 100% of every event as open Parquet. The summary index accelerates — it never gatekeeps.
      </Typography>
      {/* U11: ONE range for this page — it writes the SQL bounds below AND
          the needle search window, and it is the same range the dashboards
          and Investigate run on. */}
      <Box sx={{ ...card, mb: 2.5, padding: 2 }}>
        <TimeRangeControl
          label="Time range"
          hint="Shared with the dashboards, the needle search and Investigate — set it once."
        />
      </Box>
      <Stack gap={2.5}>
        <SqlSection />
        <NeedleSection />
      </Stack>
    </Box>
  );
}
