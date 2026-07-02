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

import { ReactElement, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

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

function gb(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function tsPretty(ns: number): string {
  return new Date(ns / 1e6).toISOString().replace('T', ' ').slice(0, 19);
}

/// Render one SQL result cell readably:
///  - binary columns (e.g. `body`) arrive hex-encoded from Arrow JSON —
///    decode to UTF-8 when the bytes are valid text;
///  - `*_ns` numeric columns pretty-print as timestamps.
function renderCell(column: string, value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  if (column.endsWith('_ns')) {
    const n = Number(s);
    if (Number.isFinite(n) && n > 1e15) return tsPretty(n);
  }
  if (/^[0-9a-fA-F]+$/.test(s) && s.length >= 8 && s.length % 2 === 0) {
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

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
    sql: "SELECT timestamp_ns, service, body FROM raw_events\nWHERE timestamp_ns >= {NOW_MINUS_1H} AND timestamp_ns < {NOW}\nLIMIT 10",
  },
  {
    label: 'grep bodies',
    sql: "SELECT timestamp_ns, service, body FROM raw_events\nWHERE timestamp_ns >= {NOW_MINUS_1H} AND timestamp_ns < {NOW}\n  AND body LIKE '%vault%'\nLIMIT 20",
  },
  {
    label: 'one service',
    sql: "SELECT timestamp_ns, body FROM raw_events\nWHERE timestamp_ns >= {NOW_MINUS_1H} AND timestamp_ns < {NOW}\n  AND service = 'svc-b'\nLIMIT 20",
  },
];

function materialise(sql: string): string {
  const now = Date.now() * 1e6;
  return sql
    .replaceAll('{NOW_MINUS_1H}', String(Math.floor(now - 3600e9)))
    .replaceAll('{NOW}', String(Math.floor(now)));
}

function SqlSection(): ReactElement {
  const [sql, setSql] = useState(materialise(SQL_PRESETS[0]!.sql));
  const [estimate, setEstimate] = useState<CostPreview | null>(null);
  const [gate, setGate] = useState<SqlGateResponse | null>(null);
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'estimate' | 'run' | null>(null);

  const columns = useMemo(() => (rows?.length ? Object.keys(rows[0]!) : []), [rows]);

  const reset = () => {
    setEstimate(null);
    setGate(null);
    setRows(null);
    setError(null);
  };

  const runEstimate = async () => {
    reset();
    setBusy('estimate');
    try {
      const r = await apiFetch('/v1/sql/estimate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql, confirm: false }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setEstimate((await r.json()) as CostPreview);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const runQuery = async (maxCostUsd?: number) => {
    setGate(null);
    setRows(null);
    setError(null);
    setBusy('run');
    try {
      const r = await apiFetch('/v1/sql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql, confirm: true, max_cost_usd: maxCostUsd }),
      });
      if (r.status === 402) {
        // The cost gate — a product feature, not a failure.
        setGate((await r.json()) as SqlGateResponse);
        return;
      }
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setRows((await r.json()) as Array<Record<string, unknown>>);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box sx={card}>
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        SQL over the raw tier
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Every event you ever ingested is an open Parquet table (<code>raw_events</code>). The
        summary index prunes the scan; the estimate is the honest cost preview. Row scans gather
        cluster-wide; aggregates (<code>count</code>/<code>GROUP BY</code>) are node-local today —
        use the dashboards for cluster-wide aggregates.
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
      <Stack direction="row" gap={1.5} alignItems="center" sx={{ mt: 1.5 }}>
        <Button variant="outlined" onClick={runEstimate} disabled={busy !== null}>
          Estimate
        </Button>
        <Button variant="contained" onClick={() => runQuery()} disabled={busy !== null}>
          Run
        </Button>
        {busy && <CircularProgress size={18} />}
        {estimate && (
          <Stack direction="row" gap={1}>
            <Chip size="small" label={`${estimate.files} files after pruning`} />
            <Chip size="small" label={`${gb(estimate.compressed_bytes)} on disk`} />
            <Chip size="small" label={`~${gb(estimate.decompressed_bytes_estimate)} scanned`} />
            <Chip size="small" color="primary" label={`$${estimate.cost_usd.toFixed(4)}`} />
            <Chip size="small" label={`~${estimate.estimated_seconds.toFixed(1)}s`} />
          </Stack>
        )}
      </Stack>

      {gate && (
        <Alert
          severity="warning"
          sx={{ mt: 1.5 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => runQuery(Math.max(gate.cost.cost_usd * 2, 0.01))}
            >
              Confirm &amp; run (~${gate.cost.cost_usd.toFixed(2)})
            </Button>
          }
        >
          Cost gate: {gate.message} — {gate.cost.files} files, ~
          {gb(gate.cost.decompressed_bytes_estimate)} scanned.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 1.5, ...mono, fontSize: 12 }}>
          {error}
        </Alert>
      )}

      {rows && (
        <Box sx={{ mt: 2, overflowX: 'auto' }}>
          <Typography variant="caption" color="text.secondary">
            {rows.length} row{rows.length === 1 ? '' : 's'}
          </Typography>
          <table style={{ borderCollapse: 'collapse', width: '100%' }} data-testid="sql-results">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c}
                    style={{ textAlign: 'left', padding: '4px 12px 4px 0', opacity: 0.6 }}
                  >
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

function NeedleSection(): ReactElement {
  const [token, setToken] = useState('');
  const [service, setService] = useState('');
  const [rangeSecs, setRangeSecs] = useState(3600);
  const [windows, setWindows] = useState<TokenWindow[] | null>(null);
  const [scanned, setScanned] = useState(0);
  const [event, setEvent] = useState<RawEventJson | null>(null);
  const [eventNote, setEventNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setWindows(null);
    setEvent(null);
    setEventNote(null);
    setError(null);
    setBusy(true);
    try {
      const now = Date.now() * 1e6;
      const qs = new URLSearchParams({
        token,
        from_ns: String(Math.floor(now - rangeSecs * 1e9)),
        to_ns: String(Math.floor(now)),
      });
      if (service) qs.set('service', service);
      const r = await apiFetch(`/v1/search_tokens?${qs}`);
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = (await r.json()) as { windows: TokenWindow[]; scanned_files: number };
      setWindows(d.windows);
      setScanned(d.scanned_files);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const drill = async (w: TokenWindow) => {
    setEvent(null);
    setEventNote(null);
    try {
      const r = await apiFetch('/v1/raw_event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          service: w.service,
          timestamp_ns: w.window_start_ns,
          window_ns: w.window_end_ns - w.window_start_ns,
        }),
      });
      if (r.status === 404) {
        setEventNote('No raw row surfaced for this window yet (still inside the flush window?).');
        return;
      }
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setEvent((await r.json()) as RawEventJson);
    } catch (e) {
      setEventNote(String(e));
    }
  };

  return (
    <Box sx={card}>
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        Needle search
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Grep months of raw logs for one token (a request id, an IP, an error string). Token blooms
        prune to the candidate windows; the drill-down lands on the verbatim event.
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
        <Button variant="contained" onClick={search} disabled={busy || token.length < 3}>
          Search
        </Button>
        {busy && <CircularProgress size={18} />}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mt: 1.5, ...mono, fontSize: 12 }}>
          {error}
        </Alert>
      )}

      {windows && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="body2" color="text.secondary">
            {windows.length} candidate window{windows.length === 1 ? '' : 's'} · {scanned} summary
            files consulted{windows.length > 0 ? ' — click a window for the raw event' : ''}
          </Typography>
          {windows.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 8 }}>
              <tbody>
                {windows.slice(0, 50).map((w, i) => (
                  <tr
                    key={i}
                    onClick={() => drill(w)}
                    style={{
                      borderTop: '1px solid rgba(128,128,128,0.15)',
                      cursor: 'pointer',
                    }}
                    title="Fetch the raw event from this window"
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
                ))}
              </tbody>
            </table>
          )}
        </Box>
      )}

      {eventNote && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          {eventNote}
        </Alert>
      )}
      {event && (
        <Box
          sx={{
            mt: 1.5,
            padding: 1.5,
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'background.border',
          }}
          data-testid="needle-raw-event"
        >
          <Typography variant="overline" color="text.secondary">
            Raw event · {event.service} · {tsPretty(event.timestamp_ns)} · via {event.source}
          </Typography>
          <Typography component="pre" sx={{ ...mono, fontSize: 12, whiteSpace: 'pre-wrap', m: 0 }}>
            {event.body_utf8 ?? `(binary body, base64) ${event.body_base64 ?? ''}`}
          </Typography>
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
        The raw tier keeps 100% of every event as open Parquet. The summary index accelerates —
        it never gatekeeps.
      </Typography>
      <Stack gap={2.5}>
        <SqlSection />
        <NeedleSection />
      </Stack>
    </Box>
  );
}
