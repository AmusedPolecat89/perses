// Copyright OBSESC Authors
//
// Regression pin for the hardcoded-ports defect (smoke finding 6): every
// shipper snippet and the step-1 curl must interpolate the port they are
// GIVEN — no legacy literal (real default or dev-only .phase-a offset) may
// creep back into the templates. Pure string assertions; no React render.

import { buildCurl } from './CurlSendStep';
import { SHIPPERS } from './ShipperConfigs';

// Every port that has ever been hardcoded in these templates: the compiled
// defaults (4317/4318/9000/9200/8088/24224) and the dev-only .phase-a
// offsets (14317/14318/18088).
const LEGACY_PORT = /\b(4317|4318|9000|9200|8088|18088|14317|14318|24224)\b/;

describe('ShipperConfigs snippets', () => {
  it('covers all six shipper protocols', () => {
    expect(SHIPPERS.map((s) => s.portKey).sort()).toEqual([
      'es_bulk',
      'fluent',
      'hec',
      'otlp_grpc',
      'otlp_http',
      'vector',
    ]);
  });

  it.each(SHIPPERS.map((s) => [s.id, s] as const))('%s interpolates the given port and hardcodes none', (_id, s) => {
    const snippet = s.snippet('h.example', 55555);
    expect(snippet).toContain('55555');
    expect(snippet).toContain('h.example');
    expect(snippet).not.toMatch(LEGACY_PORT);
  });
});

describe('buildCurl', () => {
  it('interpolates the given host and port and hardcodes none', () => {
    const cmd = buildCurl('h.example', 55555);
    expect(cmd).toContain('http://h.example:55555/_bulk');
    expect(cmd).not.toMatch(LEGACY_PORT);
  });
});
