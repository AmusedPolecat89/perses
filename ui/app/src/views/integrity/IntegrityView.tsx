// Copyright OBSESC Authors
//
// Integrity — chain-of-custody verification (Lane U6).
//
// Every flushed .obsc carries a custody node hash-linked to its
// predecessor (per-chain: `service` or `service#subshard`). This view
// walks one chain from its persisted head back toward genesis, re-hashing
// every claimed file server-side, and renders the auditor-facing verdict.
//
// HONESTY CONTRACT: the verdict card IS the product — a hash mismatch is
// never a generic error. The echoed effective `from_ns` (any retention
// clamp applied by the server) renders as "verified back to …", and
// `truncated` / `history_truncated` get explicit non-dismissable copy.
//
// Fetches go straight to /obsesc-api (same direct-fetch pattern as
// ObsescExploreView / use-node-stats): the plugin client is not
// importable from app views.

import { ReactElement, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useCapabilities } from '../../hooks/use-capabilities';

const API = '/obsesc-api';
/** The walk re-hashes up to max_files objects — generous, but abortable. */
const VERIFY_TIMEOUT_MS = 60_000;
const SERVICES_TIMEOUT_MS = 15_000;
/** Server-side walk bounds: default 512, cap 4096 (above it → 400). */
const MAX_FILES_DEFAULT = 512;
const MAX_FILES_CAP = 4096;

const mono = { fontFamily: '"JetBrains Mono", monospace' } as const;

const card = {
  borderRadius: 1.5,
  border: '1px solid',
  borderColor: 'background.border',
  backgroundColor: 'background.paper',
  padding: 2.5,
} as const;

// ─── Wire types — keep in sync with
// ui/plugins/datasource-obsesc/src/model/client.ts (frozen, Lane U0) ────

type CustodyBreakKind =
  | 'missing_head'
  | 'missing_file'
  | 'undecodable_file'
  | 'missing_custody_node'
  | 'node_hash_mismatch'
  | 'content_hash_mismatch'
  | 'seq_gap'
  | 'chain_id_mismatch'
  | 'broken_link'
  | 'unverifiable_rewrite';

interface CustodyBreak {
  kind: CustodyBreakKind;
  /** Seq the walk expected at the break point. */
  expected_seq: number;
  /** Object key at the break point. */
  key: string;
  detail: string;
}

interface ChainHead {
  format_version: number;
  chain_id: string;
  seq: number;
  /** 32 bytes, lowercase hex. */
  node_hash: string;
  node_key: string;
}

interface CustodyVerifyReport {
  chain_id: string;
  /** null = no persisted head for this chain. */
  head: ChainHead | null;
  nodes_verified: number;
  superseded_accepted: number;
  /** Chain healed over a crash (verified, not a break). */
  head_lag_accepted: number;
  /** Effective lower bound the walk ran with (retention clamp echoed). */
  from_ns: number | null;
  coarsen_merge_refs: number;
  /** Walk reached genesis or the from_ns bound with no break. */
  complete: boolean;
  /** Walk stopped at max_files before completing. */
  truncated: boolean;
  history_truncated: boolean;
  first_break: CustodyBreak | null;
}

// ─── Copy ───────────────────────────────────────────────────────────────

/** First-break kinds, humanized. The verdict card is the product. */
const BREAK_COPY: Record<CustodyBreakKind, { name: string; explain: string }> = {
  missing_head: {
    name: 'Missing head',
    explain: 'No persisted head object exists for this chain — nothing to walk.',
  },
  missing_file: {
    name: 'Missing file',
    explain: 'A file the chain claims is gone from the store.',
  },
  undecodable_file: {
    name: 'Undecodable file',
    explain: 'A claimed file exists but is not a decodable .obsc.',
  },
  missing_custody_node: {
    name: 'Missing custody node',
    explain: 'A claimed file decodes but carries no custody node.',
  },
  node_hash_mismatch: {
    name: 'Node hash mismatch',
    explain:
      'The custody node in the file is not the node the chain links to — the custody section itself was tampered or replaced.',
  },
  content_hash_mismatch: {
    name: 'Content hash mismatch',
    explain:
      'The custody node is authentic but the file sections do not hash to its claim — the payload was tampered.',
  },
  seq_gap: {
    name: 'Sequence gap',
    explain: 'Sequence numbers do not decrement by exactly one along the walk.',
  },
  chain_id_mismatch: {
    name: 'Chain-id mismatch',
    explain: 'A node on the walk belongs to a different chain.',
  },
  broken_link: {
    name: 'Broken link',
    explain:
      'A non-genesis node has no previous link to follow (or a genesis-form node appears mid-chain).',
  },
  unverifiable_rewrite: {
    name: 'Unverifiable rewrite',
    explain:
      'The file was rewritten over a node that could not be read at rewrite time — the replaced content is unrecoverable and unprovable: a real discontinuity, under its honest name.',
  },
};

function tsPretty(ns: number): string {
  return new Date(ns / 1e6).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * `AbortSignal.any` without `AbortSignal.any` (the app's TS lib target
 * predates it): aborts when EITHER input aborts — the operator's Cancel
 * button, or the timeout.
 */
function eitherSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort();
  if (a.aborted || b.aborted) ctl.abort();
  else {
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return ctl.signal;
}

// ─── Service-list helper ────────────────────────────────────────────────
// Chain ids are `service` (or `service#subshard`); derive the service
// names from the summary tier the same way the dashboards do — a grouped
// count over the recent window. Failure is quiet: free-text entry always
// works, the chips are a convenience.

interface QueryRow {
  group: string[];
  aggregates: Record<string, unknown>;
}

function useServiceNames(enabled: boolean): { services: string[]; failed: boolean } {
  const query = useQuery<string[]>({
    queryKey: ['obsesc-integrity-services'],
    enabled,
    staleTime: 60_000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const now = Date.now() * 1e6;
      const r = await fetch(`${API}/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          range: { from_ns: Math.floor(now - 24 * 3600e9), to_ns: Math.floor(now) },
          aggregate: [{ op: 'count' }],
          group_by: ['service'],
        }),
        signal: signal
          ? eitherSignal(signal, AbortSignal.timeout(SERVICES_TIMEOUT_MS))
          : AbortSignal.timeout(SERVICES_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`service list: HTTP ${r.status}`);
      const d = (await r.json()) as { rows: QueryRow[] };
      const names = new Set<string>();
      for (const row of d.rows) {
        const name = row.group[0];
        if (name) names.add(name);
      }
      return Array.from(names).sort();
    },
  });
  return { services: query.data ?? [], failed: query.isError };
}

// ─── Verdict card ───────────────────────────────────────────────────────

function EvidenceBlock({ report }: { report: CustodyVerifyReport }): ReactElement {
  const brk = report.first_break;
  const lines: string[] = [];
  if (brk) {
    lines.push(`kind:          ${brk.kind}`);
    lines.push(`expected_seq:  ${brk.expected_seq}`);
    lines.push(`key:           ${brk.key || '(none)'}`);
    lines.push(`detail:        ${brk.detail}`);
  }
  if (report.head) {
    lines.push(`head.seq:      ${report.head.seq}`);
    lines.push(`head.node_hash: ${report.head.node_hash}`);
    lines.push(`head.node_key: ${report.head.node_key}`);
  } else {
    lines.push('head:          (no persisted head for this chain)');
  }
  return (
    <Typography
      component="pre"
      data-testid="integrity-evidence"
      sx={{
        ...mono,
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        m: 0,
        mt: 1.5,
        padding: 1.5,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'background.border',
        overflowX: 'auto',
      }}
    >
      {lines.join('\n')}
    </Typography>
  );
}

function VerdictCard({ report }: { report: CustodyVerifyReport }): ReactElement {
  const brk = report.first_break;
  const verified = brk === null;
  // The echoed effective lower bound — includes any retention clamp the
  // server applied. Render it, always (PR standard #3).
  const verifiedBackTo =
    report.from_ns !== null
      ? `verified back to ${tsPretty(report.from_ns)} (effective lower bound, as echoed by the node)`
      : report.complete
        ? 'verified back to genesis'
        : null;

  return (
    <Box
      data-testid="integrity-verdict"
      data-verdict={verified ? 'verified' : brk.kind}
      sx={{
        ...card,
        borderColor: verified ? 'success.main' : 'error.main',
        borderWidth: 2,
      }}
    >
      {verified ? (
        <>
          <Stack direction="row" gap={1} alignItems="center">
            <Chip size="small" color="success" label="verified" />
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Chain intact — no break found
            </Typography>
          </Stack>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {report.nodes_verified.toLocaleString()} file
            {report.nodes_verified === 1 ? '' : 's'} re-hashed and verified
            {verifiedBackTo ? ` — ${verifiedBackTo}` : ''}.
          </Typography>
        </>
      ) : (
        <>
          <Stack direction="row" gap={1} alignItems="center">
            <Chip size="small" color="error" label={brk.kind} sx={mono} />
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Chain break: {BREAK_COPY[brk.kind]?.name ?? brk.kind}
            </Typography>
          </Stack>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {BREAK_COPY[brk.kind]?.explain ?? ''} The walk verified{' '}
            {report.nodes_verified.toLocaleString()} file
            {report.nodes_verified === 1 ? '' : 's'} between the head and this break
            {verifiedBackTo ? `; ${verifiedBackTo}` : ''}.
          </Typography>
          <EvidenceBlock report={report} />
        </>
      )}

      {(report.truncated || report.history_truncated) && (
        <Alert severity="warning" sx={{ mt: 1.5 }} data-testid="integrity-truncated">
          Older windows have aged out of retention — chain verified to the retention
          horizon, not genesis.
          {report.truncated && (
            <> The walk stopped at the max-files bound before completing; raise max files to walk further back.</>
          )}
          {report.history_truncated && (
            <> A node&apos;s recorded supersession history was truncated — rewrites older than the recorded horizon are not individually provable.</>
          )}
        </Alert>
      )}

      <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1.5 }}>
        <Chip size="small" variant="outlined" label={`${report.nodes_verified} verified`} />
        <Chip
          size="small"
          variant="outlined"
          label={`${report.superseded_accepted} superseded accepted`}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`${report.head_lag_accepted} crash-heals accepted`}
          title="Files carrying a newer authentic node than the chain links claim — the signature of a crash between a rewrite's PUT and its head commit. Verified, not a break."
        />
        <Chip
          size="small"
          variant="outlined"
          label={`${report.coarsen_merge_refs} coarsen-merge refs`}
          title="Cross-chain coarsen-merge references seen (reported, not walked — this is a bounded single-chain walk)."
        />
        <Chip
          size="small"
          variant="outlined"
          label={report.complete ? 'walk complete' : 'walk incomplete'}
        />
      </Stack>
    </Box>
  );
}

// ─── The view ───────────────────────────────────────────────────────────

function VerifySection(): ReactElement {
  const [chainId, setChainId] = useState('');
  const [fromLocal, setFromLocal] = useState('');
  const [maxFiles, setMaxFiles] = useState(String(MAX_FILES_DEFAULT));
  const [report, setReport] = useState<CustodyVerifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const { services, failed: servicesFailed } = useServiceNames(true);

  // Client-side enforcement of the server bounds (cap 4096 → 400 above).
  const maxFilesNum = Number(maxFiles);
  const maxFilesValid =
    Number.isInteger(maxFilesNum) && maxFilesNum >= 1 && maxFilesNum <= MAX_FILES_CAP;

  const run = async (): Promise<void> => {
    setReport(null);
    setError(null);
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const body: { chain_id: string; from_ns?: number; max_files?: number } = {
        chain_id: chainId.trim(),
        max_files: maxFilesNum,
      };
      if (fromLocal) {
        const ms = new Date(fromLocal).getTime();
        if (Number.isFinite(ms)) body.from_ns = Math.floor(ms * 1e6);
      }
      const r = await fetch(`${API}/v1/custody/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: eitherSignal(ctl.signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setReport((await r.json()) as CustodyVerifyReport);
    } catch (e) {
      if (ctl.signal.aborted) setError('Verify cancelled.');
      else setError(String(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  return (
    <Box sx={card}>
      <Typography variant="h6" sx={{ fontWeight: 600 }}>
        Verify a chain
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        A chain id is a service name — or <code>service#subshard</code> for a
        sub-sharded hot service. The walk starts at the chain&apos;s persisted head and
        re-hashes every claimed file back toward genesis (or your lower bound), reporting
        the first break.
      </Typography>

      {services.length > 0 && (
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 1 }}>
          {services.map((s) => (
            <Chip
              key={s}
              label={s}
              size="small"
              variant="outlined"
              sx={mono}
              onClick={() => {
                setChainId(s);
                setReport(null);
                setError(null);
              }}
            />
          ))}
        </Stack>
      )}
      {servicesFailed && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Service list unavailable (summary query failed) — enter a chain id manually.
        </Typography>
      )}

      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        <TextField
          size="small"
          label="Chain id"
          placeholder="checkout or checkout#3"
          value={chainId}
          onChange={(e) => setChainId(e.target.value)}
          sx={{ minWidth: 260 }}
          slotProps={{ input: { sx: mono } }}
        />
        <TextField
          size="small"
          type="datetime-local"
          label="Verify back to (optional)"
          value={fromLocal}
          onChange={(e) => setFromLocal(e.target.value)}
          sx={{ minWidth: 220 }}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          size="small"
          type="number"
          label={`Max files (≤ ${MAX_FILES_CAP})`}
          value={maxFiles}
          onChange={(e) => setMaxFiles(e.target.value)}
          error={!maxFilesValid}
          sx={{ width: 150 }}
          slotProps={{ htmlInput: { min: 1, max: MAX_FILES_CAP } }}
        />
        <Button
          variant="contained"
          onClick={run}
          disabled={busy || chainId.trim().length === 0 || !maxFilesValid}
        >
          Verify
        </Button>
        {busy && (
          <>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              Walking the chain — re-hashing every claimed file…
            </Typography>
            <Button size="small" onClick={() => abortRef.current?.abort()}>
              Cancel
            </Button>
          </>
        )}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mt: 1.5, ...mono, fontSize: 12 }}>
          {error}
        </Alert>
      )}

      {report && (
        <Box sx={{ mt: 2 }}>
          <VerdictCard report={report} />
        </Box>
      )}
    </Box>
  );
}

export default function IntegrityView(): ReactElement {
  const caps = useCapabilities();

  return (
    <Box sx={{ padding: 3, maxWidth: 1280, mx: 'auto' }}>
      <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>
        Integrity
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1 }}>
        Chain-of-custody over the raw tier: every flushed file is hash-linked to its
        predecessor, per service. Walk a chain to prove nothing was altered or removed.
      </Typography>
      {/* Honest framing — always visible, whatever the gate says. */}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        Local chains prove integrity within this node&apos;s storage; they are
        tamper-evident against a storage administrator only with an external anchor
        (chain heads published where the account admin cannot rewrite them) — see{' '}
        <code>docs/design/custody-chain.md</code>.
      </Typography>

      {caps.isLoading ? (
        <Stack direction="row" gap={1.5} alignItems="center">
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">
            Checking node capabilities…
          </Typography>
        </Stack>
      ) : caps.unavailable ? (
        <Alert severity="warning" data-testid="integrity-unavailable">
          Node unreachable — capability discovery failed, so it is unknown whether
          custody chains are enabled here. Check the node, then reload.
        </Alert>
      ) : !caps.custody ? (
        <Box sx={card} data-testid="custody-disabled">
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Custody chains are not enabled on this node
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            custody chains disabled: <code>summary.custody.enabled=false</code>. Enable it
            in the node&apos;s <code>config.yaml</code> (there is no config API) — chains
            begin at the first window flushed after the restart; history before that has
            no chain to verify.
          </Typography>
        </Box>
      ) : (
        <VerifySection />
      )}
    </Box>
  );
}
