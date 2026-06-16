// Copyright OBSESC Authors
//
// Step 3 of onboarding: production shipper snippets. Curl is the
// "does it work" path; once that's working, operators copy one of
// these into their telemetry agent's config.
//
// Ports come straight from .phase-a/config.yaml and the AMI's
// production CFN template. Keep these synced if either changes.

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

interface ShipperSnippet {
  id: string;
  name: string;
  port: number;
  description: string;
  language: string;
  snippet: (host: string) => string;
}

const HOST = '<your-obsesc-node>';

const SHIPPERS: ShipperSnippet[] = [
  {
    id: 'otlp-http',
    name: 'OTel Collector — OTLP/HTTP',
    port: 14318,
    description: 'Most universal for OpenTelemetry shops. Protobuf-encoded.',
    language: 'yaml',
    snippet: (host) => `exporters:
  otlphttp/obsesc:
    endpoint: http://${host}:14318
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
    port: 14317,
    description: 'Lower overhead than HTTP for high-cardinality fleets.',
    language: 'yaml',
    snippet: (host) => `exporters:
  otlp/obsesc:
    endpoint: ${host}:14317
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
    port: 9000,
    description: 'Native vector protocol; pairs well with Vector agents already in your fleet.',
    language: 'toml',
    snippet: (host) => `[sinks.obsesc]
type = "vector"
inputs = ["my_logs"]
address = "${host}:9000"`,
  },
  {
    id: 'es-bulk',
    name: 'Elasticsearch bulk',
    port: 9200,
    description: 'Drop-in for anything that already speaks ES — Filebeat, Logstash, Fluent-bit ES output.',
    language: 'yaml',
    snippet: (host) => `# Fluent-bit example
[OUTPUT]
    Name           es
    Match          *
    Host           ${host}
    Port           9200
    Index          logs
    Suppress_Type_Name On`,
  },
  {
    id: 'hec',
    name: 'Splunk HEC',
    port: 18088,
    description: 'For shops migrating off Splunk — same HEC token shape, no app rewrite.',
    language: 'bash',
    snippet: (host) => `curl -sS -X POST "http://${host}:18088/services/collector" \\
  -H "Authorization: Splunk <your-token>" \\
  -H "content-type: application/json" \\
  -d '{ "event": "hello obsesc", "source": "my-app", "host": "my-host" }'`,
  },
  {
    id: 'fluent',
    name: 'Fluent Forward',
    port: 24224,
    description: 'Native fluentd/fluent-bit forward protocol — binary, low overhead.',
    language: 'conf',
    snippet: (host) => `<match **>
  @type forward
  <server>
    host ${host}
    port 24224
  </server>
</match>`,
  },
];

export function ShipperConfigs(): ReactElement {
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
      </Box>

      <Stack gap={1}>
        {SHIPPERS.map((s) => (
          <Accordion key={s.id} disableGutters elevation={0} sx={{ border: '1px solid', borderColor: 'background.border', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ChevronDown />}>
              <Stack direction="row" alignItems="center" gap={2} flex={1}>
                <Typography variant="body1" sx={{ fontWeight: 600 }}>
                  {s.name}
                </Typography>
                <Chip size="small" label={`port ${s.port}`} variant="outlined" />
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
                {s.snippet(HOST)}
              </Box>
            </AccordionDetails>
          </Accordion>
        ))}
      </Stack>
    </Stack>
  );
}
