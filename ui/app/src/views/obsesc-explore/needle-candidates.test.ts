// Copyright OBSESC Authors
//
// The pure half of the needle results: parsing, grouping and ranking what
// `POST /v1/needle` returns. These are the claims the rendered list makes, so
// they are tested where they can be re-derived by hand rather than asserted
// through a DOM.

import {
  candidateScanBytes,
  candidateTotals,
  groupCandidates,
  NeedleCandidate,
  partitionHourMs,
  provablyExcludedFiles,
  startHere,
  verdictOf,
} from './needle-candidates';

function indexed(file: string, over: Partial<NeedleCandidate> = {}): NeedleCandidate {
  return { file, size_bytes: 1000, indexed: true, total_rowgroups: 4, rowgroups: [0], ...over };
}

function uncovered(file: string, over: Partial<NeedleCandidate> = {}): NeedleCandidate {
  return { file, size_bytes: 600, indexed: false, total_rowgroups: 0, rowgroups: null, ...over };
}

describe('partitionHourMs mirrors the Rust key parse', () => {
  it('reads the hour partition out of a raw key', () => {
    expect(partitionHourMs('raw/shard-0/2026/08/07/14/a.parquet')).toBe(Date.UTC(2026, 7, 7, 14));
  });

  it('tolerates any prefix depth — the last five segments are the partition', () => {
    expect(partitionHourMs('some/deeper/prefix/raw/2026/01/02/03/x.parquet')).toBe(Date.UTC(2026, 0, 2, 3));
  });

  it('refuses an impossible date instead of rolling it forward', () => {
    // Date.UTC would happily turn Feb 31st into March 3rd. A key we cannot
    // date must read as undated, never as a different day.
    expect(partitionHourMs('raw/shard-0/2026/02/31/00/a.parquet')).toBeNull();
  });

  it('refuses an out-of-range hour and a key that is simply a different shape', () => {
    expect(partitionHourMs('raw/shard-0/2026/08/07/99/a.parquet')).toBeNull();
    expect(partitionHourMs('raw/legacy/a.parquet')).toBeNull();
    expect(partitionHourMs('a/b/2026/08/07/x.parquet')).toBeNull();
  });
});

describe('candidateScanBytes mirrors NeedleScan::scan_bytes_estimate', () => {
  it('scales an indexed file by its surviving rowgroup fraction', () => {
    expect(candidateScanBytes(indexed('k', { size_bytes: 1000, total_rowgroups: 4, rowgroups: [0] }))).toBe(250);
  });

  it('charges an unindexed file for the whole file', () => {
    expect(candidateScanBytes(uncovered('k', { size_bytes: 600 }))).toBe(600);
  });

  it('charges the whole file when the rowgroup total is unknown', () => {
    expect(candidateScanBytes(indexed('k', { size_bytes: 900, total_rowgroups: 0, rowgroups: [0, 1] }))).toBe(900);
  });
});

describe('grouping is by day, and the rows are hours', () => {
  it('merges candidates from different shards into one hour', () => {
    const groups = groupCandidates([
      indexed('raw/shard-0/2026/08/07/14/a.parquet'),
      indexed('raw/shard-1/2026/08/07/14/b.parquet', { rowgroups: [1, 2] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.day).toBe('2026-08-07');
    expect(groups[0]!.hours).toHaveLength(1);
    expect(groups[0]!.hours[0]!.files).toBe(2);
    expect(groups[0]!.hours[0]!.rowgroups).toBe(3);
    expect(groups[0]!.hours[0]!.bytes).toBe(250 + 500);
  });

  it('puts the signature-flagged day first, then the most recent', () => {
    const groups = groupCandidates([
      uncovered('raw/shard-0/2026/08/09/01/a.parquet'),
      uncovered('raw/shard-0/2026/08/08/01/b.parquet'),
      indexed('raw/shard-0/2026/08/01/05/c.parquet'),
    ]);
    expect(groups.map((g) => g.day)).toEqual(['2026-08-01', '2026-08-09', '2026-08-08']);
    expect(groups[0]!.best).toBe('signature-flagged');
  });

  it('ranks hours inside a day by evidence, then recency', () => {
    const groups = groupCandidates([
      uncovered('raw/shard-0/2026/08/07/23/a.parquet'),
      uncovered('raw/shard-0/2026/08/07/22/b.parquet'),
      indexed('raw/shard-0/2026/08/07/02/c.parquet'),
    ]);
    expect(groups[0]!.hours.map((h) => h.startMs)).toEqual([
      Date.UTC(2026, 7, 7, 2),
      Date.UTC(2026, 7, 7, 23),
      Date.UTC(2026, 7, 7, 22),
    ]);
  });

  it('keeps undated keys as their own group, always last, never guessed into a day', () => {
    const groups = groupCandidates([
      indexed('raw/legacy-flat-key.parquet'),
      uncovered('raw/shard-0/2026/08/07/03/b.parquet'),
    ]);
    expect(groups.map((g) => g.day)).toEqual(['2026-08-07', null]);
    expect(groups[1]!.hours[0]!.startMs).toBeNull();
    expect(groups[1]!.hours[0]!.endMs).toBeNull();
  });

  it('drops nothing: every candidate is counted exactly once', () => {
    const all = [
      indexed('raw/shard-0/2026/08/07/14/a.parquet'),
      indexed('raw/shard-1/2026/08/07/14/b.parquet'),
      uncovered('raw/shard-0/2026/08/06/01/c.parquet'),
      uncovered('raw/nothing-datable.parquet'),
    ];
    const groups = groupCandidates(all);
    expect(groups.reduce((n, g) => n + g.files, 0)).toBe(all.length);
    expect(candidateTotals(all).files).toBe(all.length);
  });

  it('returns no groups for the best possible answer — nothing survived', () => {
    expect(groupCandidates([])).toEqual([]);
    expect(startHere([])).toBeNull();
  });
});

describe('the honest headline numbers', () => {
  it('separates flagged from merely-uncovered files', () => {
    const totals = candidateTotals([
      indexed('raw/shard-0/2026/08/07/14/a.parquet', { rowgroups: [0, 1] }),
      uncovered('raw/shard-0/2026/08/07/14/b.parquet'),
    ]);
    expect(totals).toMatchObject({ files: 2, indexedFiles: 1, uncoveredFiles: 1, rowgroups: 2 });
  });

  it('counts the proven absences as covered-minus-flagged', () => {
    const totals = candidateTotals([indexed('raw/shard-0/2026/08/07/14/a.parquet')]);
    const stats = {
      slabs_probed: 4,
      manifests_probed: 0,
      probe_bytes: 12_288,
      covered_files: 900,
      unindexed_files: 0,
      listing_failed: false,
    };
    expect(provablyExcludedFiles(stats, totals)).toBe(899);
  });

  it('never renders a negative exclusion count', () => {
    // A coordinator merges shards; coverage and candidates can in principle
    // arrive from different snapshots. Clamp rather than print nonsense.
    const totals = candidateTotals([indexed('a/2026/08/07/14/a.parquet'), indexed('a/2026/08/07/14/b.parquet')]);
    const stats = {
      slabs_probed: 0,
      manifests_probed: 1,
      probe_bytes: 10,
      covered_files: 1,
      unindexed_files: 0,
      listing_failed: false,
    };
    expect(provablyExcludedFiles(stats, totals)).toBe(0);
  });

  it('claims nothing when the node returned no stats', () => {
    expect(provablyExcludedFiles(null, candidateTotals([]))).toBe(0);
  });
});

describe('start here names the day and the reason', () => {
  it('points at the flagged day and qualifies the claim', () => {
    const groups = groupCandidates([
      indexed('raw/shard-0/2026/08/07/14/a.parquet'),
      uncovered('raw/shard-0/2026/08/09/01/b.parquet'),
    ]);
    const line = startHere(groups) ?? '';
    expect(line).toContain('2026-08-07');
    expect(line).toContain('1 hour');
    expect(line).toMatch(/false positive/);
  });

  it('refuses to dress an all-uncovered result up as a ranking', () => {
    const line = startHere(groupCandidates([uncovered('raw/shard-0/2026/08/07/14/a.parquet')])) ?? '';
    expect(line).toContain('Nothing here is signature-covered');
    expect(line).toMatch(/could not be ruled out/);
  });

  it('labels a candidate by what the index actually said', () => {
    expect(verdictOf(indexed('k'))).toBe('signature-flagged');
    expect(verdictOf(uncovered('k'))).toBe('not-covered');
  });
});
