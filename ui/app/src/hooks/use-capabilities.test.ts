// Copyright OBSESC Authors
//
// Unit coverage for the pure parts of useCapabilities() (Lane U0): the
// defensive wire-shape coercion and the all-disabled fallback contract.
// The fetch/react-query plumbing is covered by the e2e suite against a
// live node.

import { DISABLED_CAPABILITIES, toCapabilitiesState } from './use-capabilities';

describe('toCapabilitiesState', () => {
  it('parses a full wire response and stamps unavailable=false', () => {
    const wire = {
      preview: true,
      sql: true,
      crosstab: {
        enabled: true,
        pairs: [
          { row: 'template', col: 'level' },
          { row: 'template', col: 'error_code' },
        ],
      },
      similar: true,
      forecast: true,
      custody: false,
      alerting: true,
      compaction: true,
      cluster: { enabled: true, routing: 'arrival' },
    };
    const caps = toCapabilitiesState(wire);
    expect(caps.unavailable).toBe(false);
    expect(caps.preview).toBe(true);
    expect(caps.sql).toBe(true);
    expect(caps.crosstab.enabled).toBe(true);
    expect(caps.crosstab.pairs).toEqual([
      { row: 'template', col: 'level' },
      { row: 'template', col: 'error_code' },
    ]);
    expect(caps.similar).toBe(true);
    expect(caps.forecast).toBe(true);
    expect(caps.custody).toBe(false);
    expect(caps.alerting).toBe(true);
    expect(caps.compaction).toBe(true);
    expect(caps.cluster).toEqual({ enabled: true, routing: 'arrival' });
  });

  it('treats malformed bodies as FAILURES (throws), never as "all disabled"', () => {
    // Review fix #1: a proxy/wrong-service JSON body must surface as
    // `unavailable: true` via the hook's error path — NOT cache as a
    // valid everything-off answer for the full staleTime. The parser
    // throws; react-query then retries it like any network error, and
    // the hook returns DISABLED_CAPABILITIES (unavailable: true).
    for (const garbage of [
      null,
      undefined,
      'error page',
      42,
      [],
      {},
      { message: 'not found' },
      { crosstab: 'nope', cluster: 7 },
      { preview: 'yes' }, // preview must be a boolean, not truthy junk
    ]) {
      expect(() => toCapabilitiesState(garbage)).toThrow(/malformed capabilities/);
    }
    // The shape every malformed body ends up rendered as:
    expect(DISABLED_CAPABILITIES.unavailable).toBe(true);
    // Within a shape-valid body, malformed pair ENTRIES are filtered and
    // valid ones kept (partial degradation, not failure).
    expect(
      toCapabilitiesState({
        preview: true,
        crosstab: { enabled: true, pairs: [{ row: 'template', col: 'level' }, 'junk', { row: 1 }] },
      }).crosstab.pairs
    ).toEqual([{ row: 'template', col: 'level' }]);
  });

  it('DISABLED_CAPABILITIES carries every capability false and unavailable', () => {
    expect(DISABLED_CAPABILITIES).toEqual({
      preview: false,
      sql: false,
      crosstab: { enabled: false, pairs: [] },
      similar: false,
      forecast: false,
      custody: false,
      alerting: false,
      compaction: false,
      cluster: { enabled: false, routing: 'owner' },
      unavailable: true,
    });
  });
});
