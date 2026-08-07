// Copyright OBSESC Authors
//
// U8 — needle result ranking.
//
// The finding is a UX one, but the fix makes a CLAIM about evidence, and a
// claim about evidence is exactly the sort of thing that decays silently. So
// the ladder, the collapse rule and the "start here" line are pinned here
// rather than left to the JSX.
//
// The shape being defended: an unfiltered search returned 4,056 rows, every
// one "bloom saturated". Ranking must sink that flood beneath anything the
// needle index corroborated — without hiding a single window.

import { NeedleGroup, TokenWindow, groupNeedleWindows, signalOf, signalTally, startHere } from './needle-ranking';

const MIN = 60_000_000_000; // one minute in ns

function w(over: Partial<TokenWindow> & { service: string; window_start_ns: number }): TokenWindow {
  return {
    window_end_ns: over.window_start_ns + 5 * MIN,
    windows_merged: 1,
    event_count: 100,
    bloom_match: true,
    saturated: false,
    ...over,
  };
}

describe('the evidence ladder', () => {
  it('ranks an index-corroborated window above every bloom verdict', () => {
    expect(signalOf(w({ service: 'a', window_start_ns: 0, needle: 'candidate' }))).toBe('corroborated');
  });

  it('corroborates even a SATURATED window — the corroboration is not the bloom', () => {
    // A saturated bloom prunes nothing, so it says nothing about the token.
    // The needle index saying "candidate rowgroup here" is an independent
    // artifact, and it is still the strongest thing on offer.
    expect(signalOf(w({ service: 'a', window_start_ns: 0, saturated: true, needle: 'candidate' }))).toBe(
      'corroborated'
    );
  });

  it('reads a matched, unsaturated bloom as a bloom hit', () => {
    expect(signalOf(w({ service: 'a', window_start_ns: 0, needle: 'uncovered' }))).toBe('bloom-hit');
    expect(signalOf(w({ service: 'a', window_start_ns: 0 }))).toBe('bloom-hit');
  });

  it('reads a saturated bloom, and a missing bloom, as not-evidence', () => {
    expect(signalOf(w({ service: 'a', window_start_ns: 0, saturated: true }))).toBe('saturated');
    expect(signalOf(w({ service: 'a', window_start_ns: 0, bloom_match: false }))).toBe('no-bloom');
  });

  it('treats a node with no needle field at all as no corroboration', () => {
    // Mixed-version cluster / pre-PR#56 node: `needle` is absent, the bloom
    // verdict stands, and nothing is silently promoted.
    const legacy: TokenWindow = {
      service: 'a',
      window_start_ns: 0,
      window_end_ns: MIN,
      windows_merged: 1,
      event_count: 1,
      bloom_match: true,
      saturated: false,
    };
    expect(signalOf(legacy)).toBe('bloom-hit');
  });
});

describe('contiguous windows collapse into one run', () => {
  it('merges an unbroken chain and sums its events', () => {
    const groups = groupNeedleWindows([
      w({ service: 'a', window_start_ns: 0 }),
      w({ service: 'a', window_start_ns: 5 * MIN }),
      w({ service: 'a', window_start_ns: 10 * MIN }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runs).toHaveLength(1);
    expect(groups[0]!.runs[0]).toMatchObject({
      startNs: 0,
      endNs: 15 * MIN,
      windows: 3,
      eventCount: 300,
      signal: 'bloom-hit',
    });
  });

  it('does not merge across a gap', () => {
    const groups = groupNeedleWindows([
      w({ service: 'a', window_start_ns: 0 }),
      w({ service: 'a', window_start_ns: 60 * MIN }),
    ]);
    expect(groups[0]!.runs).toHaveLength(2);
  });

  it('does not merge across a verdict change — a run carries ONE label', () => {
    // Collapsing a corroborated window into a saturated neighbour would
    // relabel one of them. The row's chip must be true of every window in it.
    const groups = groupNeedleWindows([
      w({ service: 'a', window_start_ns: 0, needle: 'candidate' }),
      w({ service: 'a', window_start_ns: 5 * MIN, saturated: true }),
    ]);
    expect(groups[0]!.runs.map((r) => r.signal)).toEqual(['corroborated', 'saturated']);
  });

  it('never merges across services', () => {
    const groups = groupNeedleWindows([
      w({ service: 'a', window_start_ns: 0 }),
      w({ service: 'b', window_start_ns: 5 * MIN }),
    ]);
    expect(groups.map((g) => g.service).sort()).toEqual(['a', 'b']);
  });

  it('counts sub-shard-merged source buckets, not rows', () => {
    // `windows_merged` is "source buckets fed this row" — a sub-sharded hot
    // service produces one row per sub-owner, already coalesced upstream.
    const groups = groupNeedleWindows([w({ service: 'a', window_start_ns: 0, windows_merged: 4 })]);
    expect(groups[0]!.runs[0]!.windows).toBe(4);
    expect(groups[0]!.windowCount).toBe(4);
  });
});

describe('ranking puts the answer first without hiding anything', () => {
  /** The finding's shape: one corroborated needle in a saturated haystack. */
  function haystack(): TokenWindow[] {
    const out: TokenWindow[] = [];
    for (let i = 0; i < 40; i++) {
      // Deliberately non-contiguous so the flood cannot collapse away.
      out.push(w({ service: `flood-${i % 8}`, window_start_ns: i * 60 * MIN, saturated: true }));
    }
    out.push(w({ service: 'auth-gateway', window_start_ns: 500 * MIN, needle: 'candidate' }));
    return out;
  }

  it('puts the corroborated service first', () => {
    const groups = groupNeedleWindows(haystack());
    expect(groups[0]!.service).toBe('auth-gateway');
    expect(groups[0]!.best).toBe('corroborated');
  });

  it('keeps every window — ranking reorders, it never filters', () => {
    const input = haystack();
    const groups = groupNeedleWindows(input);
    const kept = groups.reduce((n, g) => n + g.runs.reduce((m, r) => m + r.members.length, 0), 0);
    expect(kept).toBe(input.length);
  });

  it('orders runs inside a group by evidence, then by recency', () => {
    const groups = groupNeedleWindows([
      w({ service: 'a', window_start_ns: 0, saturated: true }),
      w({ service: 'a', window_start_ns: 100 * MIN, needle: 'candidate' }),
      w({ service: 'a', window_start_ns: 200 * MIN, saturated: true }),
    ]);
    expect(groups[0]!.runs.map((r) => [r.signal, r.startNs])).toEqual([
      ['corroborated', 100 * MIN],
      ['saturated', 200 * MIN],
      ['saturated', 0],
    ]);
  });

  it('breaks a tie between equally-strong services by recency', () => {
    const groups = groupNeedleWindows([
      w({ service: 'older', window_start_ns: 0 }),
      w({ service: 'newer', window_start_ns: 100 * MIN }),
    ]);
    expect(groups.map((g) => g.service)).toEqual(['newer', 'older']);
  });

  it('is deterministic when evidence AND recency tie', () => {
    const a = groupNeedleWindows([w({ service: 'b', window_start_ns: 0 }), w({ service: 'a', window_start_ns: 0 })]);
    const b = groupNeedleWindows([w({ service: 'a', window_start_ns: 0 }), w({ service: 'b', window_start_ns: 0 })]);
    expect(a.map((g) => g.service)).toEqual(b.map((g) => g.service));
  });

  it('tallies every verdict for the headline', () => {
    expect(signalTally(haystack())).toEqual({
      corroborated: 1,
      'bloom-hit': 0,
      'no-bloom': 0,
      saturated: 40,
    });
  });
});

describe('"start here" says what it is claiming, and admits when it has nothing', () => {
  const groupsFor = (windows: TokenWindow[]): NeedleGroup[] => groupNeedleWindows(windows);

  it('names the corroborated service', () => {
    expect(startHere(groupsFor([w({ service: 'auth-gateway', window_start_ns: 0, needle: 'candidate' })]))).toMatch(
      /Start with auth-gateway — 1 index-corroborated run/
    );
  });

  it('says plainly that nothing is corroborated when only blooms matched', () => {
    expect(startHere(groupsFor([w({ service: 'svc', window_start_ns: 0 })]))).toMatch(
      /nothing in this result set is index-corroborated/
    );
  });

  it('refuses to dress an all-saturated result up as a ranking', () => {
    // THE finding, in one sentence: 4,056 saturated rows are "everything in
    // range", not "everywhere the token is", and the copy has to say so.
    const line = startHere(groupsFor([w({ service: 'svc', window_start_ns: 0, saturated: true })]));
    expect(line).toMatch(/SATURATED/);
    expect(line).toMatch(/Narrow the service or the time range/);
  });

  it('has nothing to say about an empty result', () => {
    expect(startHere([])).toBeNull();
  });
});
