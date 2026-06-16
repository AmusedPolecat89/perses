// Copyright OBSESC Authors
//
// Step 1 of onboarding: send a first event so the operator sees the
// pipeline light up. Uses ES bulk on :9200 because it's the only
// ingest surface that accepts a plain-JSON curl with no auth headers
// or protobuf encoding — exactly what bench-soak hits.

import { ReactElement, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ContentCopy from 'mdi-material-ui/ContentCopy';
import CheckCircle from 'mdi-material-ui/CheckCircle';
import { useNodeStats } from '../cluster/use-node-stats';

// Picked from window.location.hostname so the example "just works"
// in dev (you opened the UI on the node itself). Operators behind a
// load balancer can edit the field; we don't enforce a host check.
function defaultHostname(): string {
  if (typeof window === 'undefined') return 'localhost';
  return window.location.hostname || 'localhost';
}

const ES_BULK_PORT = 9200;

function buildCurl(host: string): string {
  // Two-line ES bulk body (action + doc), terminated with a newline
  // — the bulk parser is strict about that.
  return `curl -sS -X POST "http://${host}:${ES_BULK_PORT}/_bulk" \\
  -H "content-type: application/x-ndjson" \\
  --data-binary $'{ "index": { "_index": "logs" } }\\n{ "@timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'", "service": "onboarding-demo", "level": "info", "body": "hello obsesc" }\\n'`;
}

export function CurlSendStep(): ReactElement {
  const [host, setHost] = useState<string>(defaultHostname);
  const command = useMemo(() => buildCurl(host), [host]);
  const [copied, setCopied] = useState(false);

  const { data: stats } = useNodeStats(3_000);
  const ingestSeen = (stats?.totalIngestBytesCumulative ?? 0) > 0;

  // Remember the cumulative bytes at the moment this step mounted
  // so we can show "✓ first event received" even after a refresh
  // — looking at total>0 alone would always be true after the
  // first onboarding.
  const [baseline, setBaseline] = useState<number | null>(null);
  useEffect(() => {
    if (baseline === null && stats?.totalIngestBytesCumulative !== undefined) {
      setBaseline(stats.totalIngestBytesCumulative);
    }
  }, [stats, baseline]);
  const newSinceLanding =
    baseline !== null && stats !== undefined
      ? stats.totalIngestBytesCumulative - baseline
      : 0;
  const justReceived = newSinceLanding > 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be denied; the textarea is still selectable */
    }
  };

  return (
    <Stack gap={2}>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          1. Send your first event
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Any HTTP client works. The fastest "did it work?" check is a single curl
          to the Elasticsearch-compatible bulk endpoint — no auth, no protobuf,
          plain JSON.
        </Typography>
      </Box>

      <Stack direction="row" gap={2} alignItems="flex-end">
        <TextField
          label="Node hostname"
          size="small"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          helperText="Auto-detected from this URL. Edit if behind a load balancer."
          sx={{ flex: '0 0 320px' }}
        />
        <Chip label={`port ${ES_BULK_PORT}`} variant="outlined" />
      </Stack>

      <Box>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="overline" color="text.secondary">
            Copy &amp; run on any shell
          </Typography>
          <Button
            size="small"
            startIcon={copied ? <CheckCircle /> : <ContentCopy />}
            onClick={copy}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </Stack>
        <Box
          component="pre"
          sx={{
            backgroundColor: 'background.code',
            color: 'text.primary',
            border: '1px solid',
            borderColor: 'background.border',
            borderRadius: 1,
            padding: 1.5,
            fontSize: 12.5,
            fontFamily: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
            overflowX: 'auto',
            whiteSpace: 'pre',
            margin: 0,
          }}
        >
          {command}
        </Box>
      </Box>

      {justReceived ? (
        <Alert
          severity="success"
          variant="outlined"
          icon={<CheckCircle />}
          sx={{ '& .MuiAlert-message': { width: '100%' } }}
        >
          <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Typography variant="body2">
              <strong>First event received.</strong>{' '}
              {Math.max(0, newSinceLanding).toLocaleString()} bytes ingested since this
              page loaded.
            </Typography>
          </Stack>
        </Alert>
      ) : ingestSeen ? (
        <Alert severity="info" variant="outlined">
          This node has already received events in the past. Run the command above to
          confirm your shipper still reaches it.
        </Alert>
      ) : (
        <Alert severity="warning" variant="outlined">
          Waiting for first event… If your curl fails, check that port {ES_BULK_PORT} is
          open in the node's security group.
        </Alert>
      )}
    </Stack>
  );
}
