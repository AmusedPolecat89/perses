// Copyright OBSESC Authors
//
// Explore — the dark-data surface. Two ways into the raw tier:
//
//   1. SQL over `raw_events` (micro-Athena): estimate-first — every query
//      gets a cost preview (files after index pruning, bytes, $, seconds)
//      before it runs, and the server's cost gate (HTTP 402) renders as a
//      first-class confirmation, not an error. "Keep 100%, query it like
//      a table; the index is an accelerator, not a gatekeeper."
//
//   2. Needle search: token → bloom-pruned (service, window) candidates →
//      click through to the verbatim raw event straight off Parquet.
//
// Fetches go straight to /obsesc-api (same pattern as use-node-stats):
// this surface must work on a fresh node before any datasource exists.

import { Fragment, ReactElement, ReactNode, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { AsyncOpBar, AsyncOpStatus, asyncOpTriggerProps } from '../../components/progress/AsyncOp';
import { useAsyncOp } from '../../components/progress/useAsyncOp';
import { eitherSignal } from '../../utils/either-signal';

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

interface CostPreview {
  files: number;
  compressed_bytes: number;
  decompressed_bytes_estimate: number;
  cost_usd: number;
  estimated_seconds: number;
}

interface SqlGateResponse {
  rejected: boolean;
  cost: CostPreview;
  message: string;
}

interface TokenWindow {
  service: string;
  window_start_ns: number;
  window_end_ns: number;
  windows_merged: number;
  event_count: number;
  bloom_match: boolean;
  saturated: boolean;
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

function gb(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
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
    sql: 'SELECT timestamp_ns, service, body FROM raw_events\nWHERE timestamp_ns >= {NOW_MINUS_1H} AND timestamp_ns < {NOW}\nLIMIT 10',
  },
  {
    label: 'grep bodies',
    sql: "SELECT timestamp_ns, service, body FROM raw_events\nWHERE timestamp_ns >= {NOW_MINUS_1H} AND timestamp_ns < {NOW}\n  AND body LIKE '%vault%'\nLIMIT 20",
  },
  {
    label: 'one service',
    sql: "SELECT timestamp_ns, body FROM raw_events\nWHERE timestamp_ns >= {NOW_MINUS_1H} AND timestamp_ns < {NOW}\n  AND service = 'svc-b'\nLIMIT 20",
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
    sql: "SELECT template_key, pattern, events, windows, wildcards, similar_group\nFROM template_keys('svc-000', {NOW_MINUS_1H}, {NOW})\nLIMIT 50",
  },
  {
    label: 'template events',
    sql: "-- paste a template_key from the 'template keys' preset\nSELECT * FROM template_events('svc-000', '<template_key>', {NOW_MINUS_1H}, {NOW})\nLIMIT 20",
  },
];

function materialise(sql: string): string {
  const now = Date.now() * 1e6;
  return sql
    .replaceAll('{NOW_MINUS_1H}', String(Math.floor(now - 3600e9)))
    .replaceAll('{NOW}', String(Math.floor(now)));
}

/** Run's result: rows, OR the 402 cost gate — which is a product feature, not an error. */
interface SqlRunResult {
  rows: Array<Record<string, unknown>> | null;
  gate: SqlGateResponse | null;
}

function SqlSection(): ReactElement {
  const [sql, setSql] = useState(materialise(SQL_PRESETS[0]!.sql));

  // TWO independent operations, TWO hook instances. The single shared
  // `busy` token that used to live here is what swallowed Run clicks while
  // an estimate was in flight (U5): Estimate's own state must never be able
  // to disable Run, and neither control is disabled by its own work either.
  const estimate = useAsyncOp<CostPreview, [string]>(
    async (ctx, text) => {
      const r = await apiFetch(
        '/v1/sql/estimate',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql: text, confirm: false }),
        },
        ctx.signal
      );
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const cost = (await r.json()) as CostPreview;
      return {
        data: cost,
        receipt: `${cost.files} files after pruning · ~${gb(cost.decompressed_bytes_estimate)} to scan`,
      };
    },
    { label: 'Estimate', timeoutMs: FETCH_TIMEOUT_MS }
  );

  const query = useAsyncOp<SqlRunResult, [string, number | undefined]>(
    async (ctx, text, maxCostUsd) => {
      const r = await apiFetch(
        '/v1/sql',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql: text, confirm: true, max_cost_usd: maxCostUsd }),
        },
        ctx.signal
      );
      if (r.status === 402) {
        // The cost gate resolves as DATA, not an error: the run did exactly
        // what it was supposed to do.
        const gated = (await r.json()) as SqlGateResponse;
        return { data: { rows: null, gate: gated }, receipt: 'stopped by the cost gate' };
      }
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const got = (await r.json()) as Array<Record<string, unknown>>;
      return {
        data: { rows: got, gate: null },
        receipt: `${got.length} row${got.length === 1 ? '' : 's'}`,
      };
    },
    { label: 'Run', timeoutMs: FETCH_TIMEOUT_MS }
  );

  const cost = estimate.state.data;
  const rows = query.state.data?.rows ?? null;
  const gate = query.state.data?.gate ?? null;
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
        scan; the estimate is the honest cost preview. Row scans gather cluster-wide; aggregates (<code>count</code>/
        <code>GROUP BY</code>) are node-local today — use the dashboards for cluster-wide aggregates.
      </Typography>
      <Stack direction="row" gap={1} sx={{ mb: 1 }}>
        {SQL_PRESETS.map((p) => (
          <Chip
            key={p.label}
            label={p.label}
            size="small"
            variant="outlined"
            onClick={() => {
              setSql(materialise(p.sql));
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
      {/* flexWrap: the row must never squeeze its own buttons narrower while
          the pointer is travelling toward them — a click lost to layout
          shift has the same "nothing happened" signature as U5. */}
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap" sx={{ mt: 1.5 }}>
        <Button variant="outlined" onClick={() => estimate.run(sql)} {...asyncOpTriggerProps(estimate.state)}>
          {estimate.state.phase === 'running' ? 'Estimating…' : 'Estimate'}
        </Button>
        <Button variant="contained" onClick={() => query.run(sql, undefined)} {...asyncOpTriggerProps(query.state)}>
          {query.state.phase === 'running' ? 'Running…' : 'Run'}
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
          runningHint="Pruning the summary index for a cost preview…"
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
      {cost && (
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 0.5 }}>
          <Chip size="small" label={`${cost.files} files after pruning`} />
          <Chip size="small" label={`${gb(cost.compressed_bytes)} on disk`} />
          <Chip size="small" label={`~${gb(cost.decompressed_bytes_estimate)} scanned`} />
          <Chip size="small" color="primary" label={`$${cost.cost_usd.toFixed(4)}`} />
          <Chip size="small" label={`~${cost.estimated_seconds.toFixed(1)}s`} />
        </Stack>
      )}

      {gate && (
        <Alert
          severity="warning"
          sx={{ mt: 1.5 }}
          action={
            <Button color="inherit" size="small" onClick={() => query.run(sql, Math.max(gate.cost.cost_usd * 2, 0.01))}>
              Confirm &amp; run (~${gate.cost.cost_usd.toFixed(2)})
            </Button>
          }
        >
          Cost gate: {gate.message} — {gate.cost.files} files, ~{gb(gate.cost.decompressed_bytes_estimate)} scanned.
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

const RANGES: Array<{ label: string; seconds: number }> = [
  { label: 'Last 15 minutes', seconds: 15 * 60 },
  { label: 'Last hour', seconds: 3600 },
  { label: 'Last 6 hours', seconds: 6 * 3600 },
  { label: 'Last 24 hours', seconds: 24 * 3600 },
];

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
  scanned: number;
  /** The token this window list was searched with — the drill greps for
   *  exactly this, so editing the input afterwards can't grep a different
   *  token, and a superseded search can't leave its token behind. */
  searchedToken: string;
}

function NeedleSection(): ReactElement {
  const [token, setToken] = useState('');
  const [service, setService] = useState('');
  const [rangeSecs, setRangeSecs] = useState(3600);
  /** The row a drill is running against — for the per-row busy state. */
  const [drillTarget, setDrillTarget] = useState<TokenWindow | null>(null);

  // The hook's generation guard closes the stale-response race this search
  // used to have: two searches in flight resolved in ARRIVAL order, so a
  // slower older search overwrote the newer results.
  const search = useAsyncOp<NeedleSearchResult, [string, string, number]>(
    async (ctx, tok, svc, secs) => {
      const now = Date.now() * 1e6;
      const qs = new URLSearchParams({
        token: tok,
        from_ns: String(Math.floor(now - secs * 1e9)),
        to_ns: String(Math.floor(now)),
      });
      if (svc) qs.set('service', svc);
      const r = await apiFetch(`/v1/search_tokens?${qs}`, undefined, ctx.signal);
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = (await r.json()) as { windows: TokenWindow[]; scanned_files: number };
      return {
        data: { windows: d.windows, scanned: d.scanned_files, searchedToken: tok },
        receipt: `${d.windows.length} candidate window${d.windows.length === 1 ? '' : 's'} · ${
          d.scanned_files
        } summary files consulted`,
      };
    },
    { label: 'Search', timeoutMs: FETCH_TIMEOUT_MS }
  );

  // The drill used to have NO feedback at all for ~10 s of raw-tier grep.
  const drill = useAsyncOp<RawGrepResponse, [TokenWindow, string]>(
    async (ctx, w, tok) => {
      const r = await apiFetch(
        '/v1/raw_grep',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            service: w.service,
            from_ns: w.window_start_ns,
            to_ns: w.window_end_ns,
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
  const scanned = result?.scanned ?? 0;
  const searchedToken = result?.searchedToken ?? '';
  const grep = drill.state.data;
  const drilling = drill.state.phase === 'running';

  const onDrill = (w: TokenWindow): void => {
    // Re-entry on the SAME row is a no-op; a different row supersedes.
    if (drilling && drillTarget === w) return;
    setDrillTarget(w);
    drill.run(w, searchedToken);
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
        candidate windows; the drill-down greps the window and shows only verbatim matches — a bloom false positive says
        so instead of showing an unrelated event.
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
        <TextField
          size="small"
          select
          label="Range"
          value={rangeSecs}
          onChange={(e) => setRangeSecs(Number(e.target.value))}
          sx={{ minWidth: 160 }}
        >
          {RANGES.map((r) => (
            <MenuItem key={r.seconds} value={r.seconds}>
              {r.label}
            </MenuItem>
          ))}
        </TextField>
        {/* Blocked only by a PRECONDITION, never by in-flight work — and the
            reason is rendered next to it instead of left mute. */}
        <Button
          variant="contained"
          onClick={() => search.run(token, service, rangeSecs)}
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
              ? `Greping 1 window · ${drillTarget.event_count.toLocaleString()} events…`
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

      {windows && (
        <Box sx={{ mt: 2, opacity: search.state.phase === 'running' ? 0.45 : 1 }}>
          <Typography variant="body2" color="text.secondary">
            {windows.length} candidate window{windows.length === 1 ? '' : 's'} · {scanned} summary files consulted
            {windows.length > 0 ? ' — click a window to grep it for verbatim matches' : ''}
          </Typography>
          {windows.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 8 }}>
              <tbody>
                {windows.slice(0, 50).map((w, i) => (
                  <Fragment key={i}>
                    <tr
                      onClick={() => onDrill(w)}
                      aria-busy={drilling && drillTarget === w}
                      data-testid="needle-window-row"
                      style={{
                        borderTop: '1px solid rgba(128,128,128,0.15)',
                        cursor: 'pointer',
                      }}
                      title="Grep this window for verbatim matches"
                    >
                      <td style={{ padding: '5px 12px 5px 0' }}>
                        <Typography variant="body2" sx={mono}>
                          {w.service}
                        </Typography>
                      </td>
                      <td style={{ padding: '5px 12px 5px 0' }}>
                        <Typography variant="body2" sx={{ ...mono, fontSize: 12 }}>
                          {tsPretty(w.window_start_ns)} → {tsPretty(w.window_end_ns).slice(11)}
                        </Typography>
                      </td>
                      <td style={{ padding: '5px 12px 5px 0' }}>
                        <Typography variant="caption" color="text.secondary">
                          {w.event_count.toLocaleString()} events
                        </Typography>
                      </td>
                      <td style={{ padding: '5px 0' }}>
                        {w.saturated ? (
                          <Chip size="small" variant="outlined" color="warning" label="bloom saturated" />
                        ) : w.bloom_match ? (
                          <Chip size="small" variant="outlined" color="success" label="bloom hit" />
                        ) : (
                          <Chip size="small" variant="outlined" label="no bloom (maybe)" />
                        )}
                      </td>
                    </tr>
                    {/* Row-scoped activity. The region bar runs too — a
                      drilling row can be scrolled out of view. */}
                    {drillTarget === w && (
                      <tr>
                        <td colSpan={4} style={{ padding: 0 }}>
                          <AsyncOpBar state={drill.state} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </Box>
      )}

      {drill.state.error !== null && (
        <Alert severity="error" sx={{ mt: 1.5, ...mono, fontSize: 12 }}>
          {drill.state.error}
        </Alert>
      )}
      {grep && (grep.owners_failed ?? 0) > 0 && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          {grep.owners_failed} owner node{grep.owners_failed === 1 ? '' : 's'} failed to answer — coverage is partial;
          matches below may be incomplete.
        </Alert>
      )}
      {grep && grep.events.length === 0 && grep.files_scanned === 0 && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          No raw files cover this window yet (still inside the flush window?).
        </Alert>
      )}
      {grep && grep.events.length === 0 && grep.files_scanned > 0 && (
        <Alert severity="info" sx={{ mt: 1.5 }} data-testid="needle-honest-miss">
          No verbatim match for &quot;{searchedToken}&quot; in this window — the bloom candidate was a false positive.
        </Alert>
      )}
      {grep && grep.events.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
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
                  ? highlightToken(ev.body_utf8, searchedToken)
                  : `(binary body, base64) ${ev.body_base64 ?? ''}`}
              </Typography>
            </Box>
          ))}
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
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2.5 }}>
        The raw tier keeps 100% of every event as open Parquet. The summary index accelerates — it never gatekeeps.
      </Typography>
      <Stack gap={2.5}>
        <SqlSection />
        <NeedleSection />
      </Stack>
    </Box>
  );
}
