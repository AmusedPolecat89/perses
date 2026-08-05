// Copyright OBSESC Authors
//
// Step 3 of onboarding: production shipper snippets. Curl is the
// "does it work" path; once that's working, operators copy one of
// these into their telemetry agent's config.
//
// Ports come from GET /v1/capabilities `ingest_ports` (the node's own
// config), falling back to the compiled obsesc-config defaults when
// the node can't answer — with a visible caption so nobody points a
// shipper at a guessed port.

import { ReactElement } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  Stack,
  Typography,
} from '@mui/material';
import ChevronDown from 'mdi-material-ui/ChevronDown';
import { DEFAULT_INGEST_PORTS, IngestPorts, useCapabilities } from '../../hooks/use-capabilities';

interface ShipperSnippet {
  id: string;
  name: string;
  portKey: keyof IngestPorts;
  description: string;
  language: string;
  snippet: (host: string, port: number) => string;
}

const HOST = '<your-obsesc-node>';

/** Exported for the unit test (no-hardcoded-ports regression pin). */
export const SHIPPERS: ShipperSnippet[] = [
  {
    id: 'otlp-http',
    name: 'OTel Collector — OTLP/HTTP',
    portKey: 'otlp_http',
    description: 'Most universal for OpenTelemetry shops. Protobuf-encoded.',
    language: 'yaml',
    snippet: (host, port) => `exporters:
  otlphttp/obsesc:
    endpoint: http://${host}:${port}
    encoding: proto

service:
  pipelines:
    logs:
      exporters: [otlphttp/obsesc]
    traces:
      exporters: [otlphttp/obsesc]`,
  },
  {
    id: 'otlp-grpc',
    name: 'OTel Collector — OTLP/gRPC',
    portKey: 'otlp_grpc',
    description: 'Lower overhead than HTTP for high-cardinality fleets.',
    language: 'yaml',
    snippet: (host, port) => `exporters:
  otlp/obsesc:
    endpoint: ${host}:${port}
    tls:
      insecure: true

service:
  pipelines:
    logs:
      exporters: [otlp/obsesc]`,
  },
  {
    id: 'vector',
    name: 'Vector',
    portKey: 'vector',
    description: 'Native vector protocol; pairs well with Vector agents already in your fleet.',
    language: 'toml',
    snippet: (host, port) => `[sinks.obsesc]
type = "vector"
inputs = ["my_logs"]
address = "${host}:${port}"`,
  },
  {
    id: 'es-bulk',
    name: 'Elasticsearch bulk',
    portKey: 'es_bulk',
    description: 'Drop-in for anything that already speaks ES — Filebeat, Logstash, Fluent-bit ES output.',
    language: 'yaml',
    snippet: (host, port) => `# Fluent-bit example
[OUTPUT]
    Name           es
    Match          *
    Host           ${host}
    Port           ${port}
    Index          logs
    Suppress_Type_Name On`,
  },
  {
    id: 'hec',
    name: 'Splunk HEC',
    portKey: 'hec',
    description: 'For shops migrating off Splunk — same HEC token shape, no app rewrite.',
    language: 'bash',
    snippet: (host, port) => `curl -sS -X POST "http://${host}:${port}/services/collector" \\
  -H "Authorization: Splunk <your-token>" \\
  -H "content-type: application/json" \\
  -d '{ "event": "hello obsesc", "source": "my-app", "host": "my-host" }'`,
  },
  {
    id: 'fluent',
    name: 'Fluent Forward',
    portKey: 'fluent',
    description: 'Native fluentd/fluent-bit forward protocol — binary, low overhead.',
    language: 'conf',
    snippet: (host, port) => `<match **>
  @type forward
  <server>
    host ${host}
    port ${port}
  </server>
</match>`,
  },
];

export function ShipperConfigs(): ReactElement {
  const caps = useCapabilities();
  const ports = caps.ingest_ports ?? DEFAULT_INGEST_PORTS;
  return (
    <Stack gap={2}>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          3. Wire up your production shippers
        </Typography>
        <Typography variant="body2" color="text.secondary">
          The node exposes six ingest protocols. Pick the one that matches what
          your agents already speak; you can use multiple at once.
        </Typography>
        {caps.ingest_ports === null && !caps.isLoading && (
          <Typography variant="caption" color="warning.main">
            Ports shown are compiled defaults — the node didn&apos;t report its own. Verify the <code>ingest:</code>{' '}
            section of the node&apos;s config.
          </Typography>
        )}
      </Box>

      <Stack gap={1}>
        {SHIPPERS.map((s) => (
          <Accordion key={s.id} disableGutters elevation={0} sx={{ border: '1px solid', borderColor: 'background.border', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ChevronDown />}>
              <Stack direction="row" alignItems="center" gap={2} flex={1}>
                <Typography variant="body1" sx={{ fontWeight: 600 }}>
                  {s.name}
                </Typography>
                <Chip size="small" label={`port ${ports[s.portKey]}`} variant="outlined" />
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {s.description}
              </Typography>
              <Box
                component="pre"
                sx={{
                  backgroundColor: 'background.code',
                  borderRadius: 1,
                  padding: 1.5,
                  fontSize: 12.5,
                  fontFamily: '"JetBrains Mono", monospace',
                  overflowX: 'auto',
                  whiteSpace: 'pre',
                  margin: 0,
                }}
              >
                {s.snippet(HOST, ports[s.portKey])}
              </Box>
            </AccordionDetails>
          </Accordion>
        ))}
      </Stack>
    </Stack>
  );
}
