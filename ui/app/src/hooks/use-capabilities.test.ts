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

  it('degrades malformed bodies to the all-disabled shape (never throws)', () => {
    for (const garbage of [null, undefined, 'error page', 42, [], {}]) {
      const caps = toCapabilitiesState(garbage);
      expect(caps.preview).toBe(false);
      expect(caps.sql).toBe(false);
      expect(caps.crosstab).toEqual({ enabled: false, pairs: [] });
      expect(caps.cluster).toEqual({ enabled: false, routing: 'owner' });
    }
    // A wrong-shaped-but-object body must not throw either.
    expect(toCapabilitiesState({ crosstab: 'nope', cluster: 7 }).crosstab.pairs).toEqual([]);
    // Malformed pair entries are filtered, valid ones kept.
    expect(
      toCapabilitiesState({
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
