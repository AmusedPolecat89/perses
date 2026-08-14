// Copyright OBSESC Authors
//
// Needle CANDIDATE ranking — the `POST /v1/needle` shape.
//
// This module replaced needle-ranking.ts when the Explore needle box stopped
// calling `GET /v1/search_tokens`. That endpoint was not merely slow: it walks
// the summary tier from the root and fully decodes every `.obsc` file it finds
// (363,012 on one node of the 9 TB cluster) whatever range you asked for, so
// its cost is a function of the ESTATE, not of the question. It never returned
// in 45 s and it never would have. `POST /v1/needle` answers the same question
// — "has this token appeared anywhere in the estate in this range?" — from the
// bit-sliced needle index in bounded ranged reads, and returned in 0 s on the
// same cluster and the same token.
//
// The answer it gives back is a DIFFERENT KIND OF ANSWER, and this module
// exists so the UI states it as what it is rather than dressing it up as the
// old one:
//
//   * The old wire returned `(service, window)` rows carrying event counts and
//     bloom verdicts. The needle index has NONE of that. It is service-blind
//     by construction — a cross-estate IOC sweep has no service to route by —
//     and it counts rowgroups, never events.
//   * What it does return is a bounded SURVIVOR SET: raw-tier files (and, for
//     signature-covered ones, the individual rowgroups) that may contain the
//     token, plus the honest coverage labels. Files that are covered and
//     absent from that set are PROVABLY token-free.
//
// So the list is grouped by the only time the answer actually carries: the UTC
// hour partition in each candidate's object key. Everything here is pure —
// same input, same output, no clock — because a ranking the operator cannot
// re-derive is a ranking they have to take on faith.

/** One candidate file on one shard (`NeedleCandidate` on the wire). */
export interface NeedleCandidate {
  /** Raw-tier object key, e.g. `raw/shard-0/2026/08/07/14/a.parquet`. */
  file: string;
  /** On-disk (compressed) size. */
  size_bytes: number;
  /** `true`: signature-covered, and `rowgroups` scopes the scan to part of
   *  the file. `false`: NOT covered by any signature artifact — the whole
   *  file is a candidate, and the index cannot say either way. */
  indexed: boolean;
  /** Total rowgroups (indexed files; 0 when unknown/unindexed). */
  total_rowgroups: number;
  /** Candidate rowgroup ordinals; `null` = whole file. */
  rowgroups: number[] | null;
}

/** Probe transparency counters, summed across shards (`NeedleStats`). */
export interface NeedleStats {
  slabs_probed: number;
  manifests_probed: number;
  probe_bytes: number;
  covered_files: number;
  unindexed_files: number;
  listing_failed: boolean;
  manifest_budget_exhausted?: boolean;
}

/**
 * The evidence ladder, strongest first. Two rungs, because the needle index
 * makes exactly two kinds of statement:
 *
 *   signature-flagged — a signature artifact covers this file and the token's
 *                       bits are set in these rowgroups. One-sided: a hit can
 *                       be a false positive, an absence never is.
 *   not-covered       — no signature artifact covers this file, so the whole
 *                       file is kept as a candidate. NOT evidence; it is the
 *                       index declining to answer, over-keeping rather than
 *                       risking a false negative.
 */
export type CandidateVerdict = 'signature-flagged' | 'not-covered';

const VERDICT_RANK: Record<CandidateVerdict, number> = {
  'signature-flagged': 0,
  'not-covered': 1,
};

export const VERDICT_LABEL: Record<CandidateVerdict, string> = {
  'signature-flagged': 'signature-flagged',
  'not-covered': 'not covered (whole file kept)',
};

export const VERDICT_EXPLAIN: Record<CandidateVerdict, string> = {
  'signature-flagged':
    "The bit-sliced needle index covers this file and the token's bits are set in these rowgroups. One-sided guarantee: a hit may be a false positive (~1%), an absence never is. Start here.",
  'not-covered':
    'No signature artifact covers this file — never compacted, or its manifest was unreadable or over the probe budget — so the whole file is kept as a candidate. The index cannot corroborate it either way; this is over-keeping, never a false negative.',
};

export function verdictOf(c: NeedleCandidate): CandidateVerdict {
  return c.indexed ? 'signature-flagged' : 'not-covered';
}

/**
 * The bytes a survivor scan would read for this candidate: the whole file when
 * it is unindexed, the rowgroup fraction of it when it is not. Mirrors the
 * Rust `NeedleScan::scan_bytes_estimate` exactly, so the per-hour figures here
 * and the server's own `scan_estimate` are denominated the same way.
 */
export function candidateScanBytes(c: NeedleCandidate): number {
  const rgs = c.rowgroups;
  if (rgs !== null && rgs !== undefined && c.total_rowgroups > 0) {
    return Math.floor((c.size_bytes * rgs.length) / c.total_rowgroups);
  }
  return c.size_bytes;
}

const HOUR_MS = 3_600_000;

/**
 * The UTC hour partition a raw key was written into, in ms, or `null` when the
 * key does not carry one (legacy layouts). Mirrors the Rust `partition_day`
 * parse — the last five segments are `YYYY/MM/DD/HH/<file>` — and validates by
 * round-trip so `2026/02/31/00/x.parquet` is rejected instead of silently
 * becoming March 3rd. A key we cannot date is never GUESSED into an hour.
 */
export function partitionHourMs(file: string): number | null {
  const parts = file.split('/');
  const n = parts.length;
  if (n < 5) return null;
  const seg = parts.slice(n - 5, n - 1);
  if (!seg.every((s) => /^\d{1,4}$/.test(s))) return null;
  const [y, mo, d, h] = seg.map(Number) as [number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23) return null;
  const ms = Date.UTC(y, mo - 1, d, h);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/** One UTC hour partition's worth of candidates, merged across shards. */
export interface CandidateHour {
  /** UTC hour start in ms; `null` for keys that carry no hour partition. */
  startMs: number | null;
  /** `startMs + 1h`, or `null` alongside a `null` start. */
  endMs: number | null;
  files: number;
  /** Rowgroup-scaled scan bytes — what scanning these survivors would read. */
  bytes: number;
  indexedFiles: number;
  uncoveredFiles: number;
  /** Candidate rowgroups across the signature-covered files in this hour. */
  rowgroups: number;
  /** Strongest verdict present in this hour. */
  best: CandidateVerdict;
}

/** One UTC day's hours. The day is the group; the hour is the row. */
export interface CandidateDay {
  /** `2026-08-07`, or `null` for the undated group. */
  day: string | null;
  hours: CandidateHour[];
  files: number;
  bytes: number;
  indexedFiles: number;
  uncoveredFiles: number;
  best: CandidateVerdict;
  /** Latest hour start in the group — the recency tie-break. */
  latestMs: number;
}

function dayOf(hourMs: number): string {
  return new Date(hourMs).toISOString().slice(0, 10);
}

function strongest(a: CandidateVerdict, b: CandidateVerdict): CandidateVerdict {
  return VERDICT_RANK[a] <= VERDICT_RANK[b] ? a : b;
}

/**
 * Group → rank. Days carrying signature-flagged files come first (that is the
 * only rung that is evidence), then the most recent; hours inside a day follow
 * the same ladder. Undated candidates are their own group and always last:
 * they are a real answer, but not one with a time on it.
 *
 * Nothing is dropped. Every candidate the node returned is in exactly one
 * hour, counted in its day, and counted again in the headline totals.
 */
export function groupCandidates(candidates: NeedleCandidate[]): CandidateDay[] {
  const byHour = new Map<string, CandidateHour>();
  for (const c of candidates) {
    const startMs = partitionHourMs(c.file);
    const key = startMs === null ? 'undated' : String(startMs);
    let hour = byHour.get(key);
    if (hour === undefined) {
      hour = {
        startMs,
        endMs: startMs === null ? null : startMs + HOUR_MS,
        files: 0,
        bytes: 0,
        indexedFiles: 0,
        uncoveredFiles: 0,
        rowgroups: 0,
        best: 'not-covered',
      };
      byHour.set(key, hour);
    }
    hour.files += 1;
    hour.bytes += candidateScanBytes(c);
    if (c.indexed) {
      hour.indexedFiles += 1;
      hour.rowgroups += c.rowgroups?.length ?? 0;
    } else {
      hour.uncoveredFiles += 1;
    }
    hour.best = strongest(hour.best, verdictOf(c));
  }

  const byDay = new Map<string, CandidateDay>();
  for (const hour of byHour.values()) {
    const day = hour.startMs === null ? null : dayOf(hour.startMs);
    const key = day ?? 'undated';
    let group = byDay.get(key);
    if (group === undefined) {
      group = {
        day,
        hours: [],
        files: 0,
        bytes: 0,
        indexedFiles: 0,
        uncoveredFiles: 0,
        best: 'not-covered',
        latestMs: 0,
      };
      byDay.set(key, group);
    }
    group.hours.push(hour);
    group.files += hour.files;
    group.bytes += hour.bytes;
    group.indexedFiles += hour.indexedFiles;
    group.uncoveredFiles += hour.uncoveredFiles;
    group.best = strongest(group.best, hour.best);
    group.latestMs = Math.max(group.latestMs, hour.startMs ?? 0);
  }

  const groups = [...byDay.values()];
  for (const g of groups) {
    g.hours.sort((a, b) => VERDICT_RANK[a.best] - VERDICT_RANK[b.best] || (b.startMs ?? -1) - (a.startMs ?? -1));
  }
  groups.sort((a, b) => {
    // Undated last, always: it is the one group with no time to rank by.
    if ((a.day === null) !== (b.day === null)) return a.day === null ? 1 : -1;
    return VERDICT_RANK[a.best] - VERDICT_RANK[b.best] || b.latestMs - a.latestMs;
  });
  return groups;
}

/** Headline totals over the whole candidate set. */
export interface CandidateTotals {
  files: number;
  bytes: number;
  indexedFiles: number;
  uncoveredFiles: number;
  rowgroups: number;
}

export function candidateTotals(candidates: NeedleCandidate[]): CandidateTotals {
  const out: CandidateTotals = { files: 0, bytes: 0, indexedFiles: 0, uncoveredFiles: 0, rowgroups: 0 };
  for (const c of candidates) {
    out.files += 1;
    out.bytes += candidateScanBytes(c);
    if (c.indexed) {
      out.indexedFiles += 1;
      out.rowgroups += c.rowgroups?.length ?? 0;
    } else {
      out.uncoveredFiles += 1;
    }
  }
  return out;
}

/**
 * Files the index PROVED token-free: covered by a signature artifact in range
 * and absent from the candidate set. This is the number that makes the whole
 * surface worth looking at — it is an exact absence, not a heuristic — so it
 * is computed rather than narrated, and clamped at zero because a coordinator
 * merging shards must never render a negative count if a shard's coverage and
 * its candidates arrive from different snapshots.
 */
export function provablyExcludedFiles(stats: NeedleStats | null, totals: CandidateTotals): number {
  if (stats === null) return 0;
  return Math.max(0, stats.covered_files - totals.indexedFiles);
}

/**
 * The one-line "start here", or `null` when there is nothing to say. It names
 * a day and the reason it is first, and it never promises corroboration the
 * index did not give.
 */
export function startHere(groups: CandidateDay[]): string | null {
  const first = groups[0];
  if (first === undefined) return null;
  if (first.best === 'not-covered') {
    return (
      'Nothing here is signature-covered: every candidate is a whole file the index could not corroborate ' +
      'either way, so this list is "what could not be ruled out", not "where the token is". Compact these ' +
      'days, or scan the survivors to settle it.'
    );
  }
  const flagged = first.hours.filter((h) => h.best === 'signature-flagged').length;
  const where = first.day ?? 'the undated candidates';
  return `Start with ${where} — ${flagged} hour${flagged === 1 ? '' : 's'} the signature index flagged (a hit may be a ~1% false positive; the absences it reports are exact).`;
}
