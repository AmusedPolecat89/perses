// Copyright OBSESC Authors
//
// Fingerprint-epoch admin card (Lane U4) — lives on the Cluster page because
// a projection epoch is deployment-level state: minting one freezes the
// IDF + projection every node stamps into new fingerprints (shared via the
// cluster manifest).
//
// Reads GET /obsesc-api/v1/similar/epoch; "Mint new epoch" opens a real
// operator-action dialog (POST, scan range ≤ 31 days enforced client-side).
// Gating is tri-state via useCapabilities(): loading, node-unreachable and
// capability-disabled each render distinct designed states (mint disabled).
// A 503 from the mint renders as the designed "artifact/manifest stores not
// configured" state, never an error toast.

import { ReactElement, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCapabilities } from '../../hooks/use-capabilities';
import { AsyncOpBar, AsyncOpStatus } from '../../components/progress/AsyncOp';
import { useTrackedOp } from '../../components/progress/useAsyncOp';
import { eitherSignal } from '../../utils/either-signal';

const API = '/obsesc-api';
const FETCH_TIMEOUT_MS = 60_000;
const NS_PER_MS = 1e6;
const MAX_MINT_RANGE_MS = 31 * 86_400_000; // server rejects scans over 31 days

// ── Wire shapes — keep in sync with the frozen
//    ui/plugins/datasource-obsesc/src/model/client.ts (ObsescEpochStatus /
//    ObsescMintEpochRequest / ObsescMintEpochResponse). ──────────────────────

interface EpochStatus {
  loaded: boolean;
  epoch_id?: number;
  template_key_version?: number;
  windows_scanned?: number;
  /// IDF table entries — the epoch's frozen template-key count.
  idf_entries?: number;
}

interface MintEpochResponse {
  epoch_id: number;
  template_key_version: number;
  windows_scanned: number;
  /// Coverage signal: DF comes from THIS node's shard only.
  services_scanned: number;
  idf_entries: number;
  manifest_epoch: number;
}

async function apiFetch(
  path: string,
  init?: RequestInit,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    // The timeout applies even when a caller signal is threaded.
    signal: eitherSignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)),
  });
}

/// A mint 503 means the node has no artifact/manifest stores — a designed
/// product state, not an error.
class StoresNotConfiguredError extends Error {}

function toLocalInputValue(d: Date): string {
  // datetime-local wants local time without seconds: YYYY-MM-DDTHH:mm.
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FingerprintEpochCard(): ReactElement {
  const caps = useCapabilities();
  const queryClient = useQueryClient();
  const [mintOpen, setMintOpen] = useState(false);

  const epochQuery = useQuery<EpochStatus>({
    // Only ask once the capability is confirmed.
    enabled: caps.similar,
    queryKey: ['obsesc-similar-epoch'],
    // Epochs change on operator mints, not on a cadence — no polling;
    // the mint mutation invalidates this.
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const r = await apiFetch('/v1/similar/epoch', undefined, signal);
      if (!r.ok) throw new Error(`GET /v1/similar/epoch: HTTP ${r.status}`);
      return (await r.json()) as EpochStatus;
    },
  });

  // Tri-state gate (standard 4, review fix #2): loading, node-unreachable,
  // capability-disabled and enabled each render DISTINCT designed states —
  // the card shell never silently vanishes.
  const epoch = epochQuery.data;
  return (
    <Box
      sx={{
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: 'background.border',
        backgroundColor: 'background.paper',
        padding: 2.5,
        mt: 3,
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
        <Box>
          <Stack direction="row" alignItems="center" gap={1.5}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Fingerprint epoch
            </Typography>
            {epoch &&
              (epoch.loaded ? (
                <Chip size="small" color="success" label={`epoch ${epoch.epoch_id}`} />
              ) : (
                <Chip size="small" variant="outlined" label="no epoch loaded" />
              ))}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            The frozen IDF + projection that behavioral fingerprints are stamped with.
            Windows are only comparable within one epoch — cross-epoch candidates are
            skipped in similarity results (and counted), never fudged.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          disabled={!caps.similar}
          onClick={() => setMintOpen(true)}
        >
          Mint new epoch
        </Button>
      </Stack>

      {/* Capability tri-state: loading ≠ unreachable ≠ disabled. */}
      {caps.isLoading && (
        <Box sx={{ mt: 2 }}>
          <CircularProgress size={18} />
        </Box>
      )}
      {!caps.isLoading && caps.unavailable && (
        <Alert severity="warning" variant="outlined" sx={{ mt: 2 }}>
          Node unreachable — can&apos;t determine whether similarity fingerprints are
          enabled here. Epoch status will load once the node answers.
        </Alert>
      )}
      {!caps.isLoading && !caps.unavailable && !caps.similar && (
        <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
          Similarity fingerprints not enabled on this node — artifact/manifest stores
          not configured in config.yaml. Configure both to mint epochs and search
          for similar windows.
        </Alert>
      )}

      {caps.similar && (
        <>
          {epochQuery.isLoading && (
            <Box sx={{ mt: 2 }}>
              <CircularProgress size={18} />
            </Box>
          )}
          {epochQuery.isError && (
            <Alert severity="error" variant="outlined" sx={{ mt: 2 }}>
              Couldn&apos;t read the epoch status:{' '}
              {epochQuery.error instanceof Error
                ? epochQuery.error.message
                : String(epochQuery.error)}
            </Alert>
          )}

          {epoch &&
            (epoch.loaded ? (
              <Stack direction="row" gap={4} sx={{ mt: 2, flexWrap: 'wrap' }}>
                <EpochStat label="epoch id" value={String(epoch.epoch_id ?? '—')} />
                <EpochStat label="IDF keys" value={String(epoch.idf_entries ?? '—')} />
                <EpochStat label="windows scanned" value={String(epoch.windows_scanned ?? '—')} />
                <EpochStat
                  label="template-key version"
                  value={String(epoch.template_key_version ?? '—')}
                />
              </Stack>
            ) : (
              <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
                No projection epoch is loaded on this node — new windows get no fingerprints
                and similarity search has nothing to compare. Mint one to start.
              </Alert>
            ))}
        </>
      )}

      <MintEpochDialog
        open={mintOpen}
        onClose={() => setMintOpen(false)}
        onMinted={() => void queryClient.invalidateQueries({ queryKey: ['obsesc-similar-epoch'] })}
      />
    </Box>
  );
}

function EpochStat(props: { label: string; value: string }): ReactElement {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {props.label}
      </Typography>
      <Typography sx={{ fontFamily: '"JetBrains Mono", monospace', fontWeight: 600 }}>
        {props.value}
      </Typography>
    </Box>
  );
}

interface MintEpochDialogProps {
  open: boolean;
  onClose: () => void;
  onMinted: () => void;
}

function MintEpochDialog({ open, onClose, onMinted }: MintEpochDialogProps): ReactElement {
  // Default scan range: the last 7 days, ending now.
  const [from, setFrom] = useState(() => toLocalInputValue(new Date(Date.now() - 7 * 86_400_000)));
  const [to, setTo] = useState(() => toLocalInputValue(new Date()));

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const rangeInvalid = !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs;
  const rangeTooWide = !rangeInvalid && toMs - fromMs > MAX_MINT_RANGE_MS;

  const mint = useMutation<MintEpochResponse, Error>({
    mutationFn: async () => {
      const r = await apiFetch('/v1/similar/epoch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Keep in sync with client.ts ObsescMintEpochRequest.
        body: JSON.stringify({
          from_ns: Math.floor(fromMs * NS_PER_MS),
          to_ns: Math.floor(toMs * NS_PER_MS),
        }),
      });
      if (r.status === 503) throw new StoresNotConfiguredError(await r.text());
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      return (await r.json()) as MintEpochResponse;
    },
    onSuccess: onMinted,
  });

  // A WRITE: elapsed + a receipt, no Cancel — aborting the fetch would
  // not un-mint an epoch, so offering one would lie.
  const mintOp = useTrackedOp(mint.isLoading, {
    timeoutMs: FETCH_TIMEOUT_MS,
    receipt: mint.data ? `epoch ${mint.data.epoch_id} · ${mint.data.idf_entries} IDF keys` : null,
  });

  const close = (): void => {
    mint.reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Mint a new projection epoch</DialogTitle>
      <DialogContent>
        <Stack gap={2} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            This is a real operator action. Minting scans this node&apos;s summary tier
            over the range below, freezes the IDF weights + projection into a new epoch
            artifact, and bumps the cluster manifest. New fingerprints are stamped with
            the new epoch from then on; windows fingerprinted under older epochs are
            <strong> skipped</strong> in cross-epoch comparisons (counted in results,
            never fudged).
          </Typography>

          <Stack direction="row" gap={2}>
            <TextField
              label="Scan from"
              type="datetime-local"
              size="small"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              InputLabelProps={{ shrink: true }}
              fullWidth
            />
            <TextField
              label="Scan to"
              type="datetime-local"
              size="small"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              InputLabelProps={{ shrink: true }}
              fullWidth
            />
          </Stack>
          {rangeInvalid && (
            <Alert severity="warning" variant="outlined">
              &quot;Scan from&quot; must be before &quot;scan to&quot;.
            </Alert>
          )}
          {rangeTooWide && (
            <Alert severity="warning" variant="outlined">
              The scan range is capped at 31 days — narrow it.
            </Alert>
          )}

          <Typography variant="caption" color="text.secondary">
            Document frequencies come from this node&apos;s summary shard only — mint
            from the node with the widest coverage and check the services-scanned count
            in the result. Excluding individual services from the scan isn&apos;t
            supported by the endpoint yet.
          </Typography>

          <AsyncOpBar state={mintOp} testId="asyncop-bar-mint" />
          <AsyncOpStatus
            id="cluster-mint"
            state={mintOp}
            label="Mint"
            runningHint="Scanning the summary tier…"
          />

          {mint.error instanceof StoresNotConfiguredError && (
            <Alert severity="info" variant="outlined">
              <strong>Artifact/manifest stores not configured on this node.</strong>{' '}
              Epoch minting needs object storage for the epoch artifact and the CAS
              manifest pointer — configure both in the node&apos;s config.yaml, then
              retry.
            </Alert>
          )}
          {mint.error && !(mint.error instanceof StoresNotConfiguredError) && (
            <Alert severity="error" variant="outlined">
              Mint failed: {mint.error.message}
            </Alert>
          )}

          {mint.data && (
            <Alert severity="success" variant="outlined">
              Minted epoch {mint.data.epoch_id} (manifest epoch {mint.data.manifest_epoch}):{' '}
              {mint.data.idf_entries} IDF keys from {mint.data.windows_scanned} windows across{' '}
              {mint.data.services_scanned} service{mint.data.services_scanned === 1 ? '' : 's'}{' '}
              on this shard.
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} color="inherit" data-testid="fingerprint-epoch-dismiss-btn">
          {mint.data ? 'Close' : 'Cancel'}
        </Button>
        {!mint.data && (
          <Button
            variant="contained"
            disabled={rangeInvalid || rangeTooWide || mint.isLoading}
            onClick={() => mint.mutate()}
          >
            Mint epoch
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default FingerprintEpochCard;
