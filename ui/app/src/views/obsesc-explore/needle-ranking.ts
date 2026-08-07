// Copyright OBSESC Authors
//
// Needle result ranking (U8).
//
// The live drive that opened this finding got **4,056 near-identical rows,
// every one chipped "bloom saturated"** from one unfiltered search. Nothing
// there was wrong: a saturated bloom prunes nothing, so every window it
// covers survives, and labelling that honestly is the right call. But an
// undifferentiated wall of 4,056 identical rows READS as failure, and the
// operator's own fix — typing a service name, which cut it to 50 rows —
// is a fix the product should not have needed a human for.
//
// So the list is no longer a list. It is:
//
//   1. RANKED by evidence. The bit-sliced needle index (PR #56) now labels
//      every surviving window `candidate` / `uncovered` / `unavailable`, and
//      `candidate` is a SECOND, independent artifact agreeing that the token
//      is in there. That is the strongest thing this product can say short of
//      the verbatim grep, and it goes to the top.
//   2. COLLAPSED. Contiguous windows carrying the same verdict are one run —
//      `10:00 → 14:00 · 48 windows` is one fact, not 48 rows — and the drill
//      greps the whole run in one request.
//   3. GROUPED by service, best-evidence service first, so the answer to
//      "where do I start" is the first thing on screen.
//
// Nothing is hidden: every window is still present, still counted, still
// drillable. Ranking is a claim about ORDER, and the order it claims is
// exactly the evidence ladder above — which is why the ladder is a pure
// function with its own tests rather than a sort comparator buried in JSX.

/** The needle index's verdict, `snake_case` on the wire (`NeedleStatus`). */
export type NeedleStatus = 'candidate' | 'uncovered' | 'unavailable';

/** One `(service, window)` the token search returned. */
export interface TokenWindow {
  service: string;
  window_start_ns: number;
  window_end_ns: number;
  windows_merged: number;
  event_count: number;
  /** `false` = the window carries NO bloom and is included as a "maybe". */
  bloom_match: boolean;
  /** The bloom overflowed at write time and prunes nothing. */
  saturated: boolean;
  /** Absent on a node that predates the needle assist. */
  needle?: NeedleStatus;
}

/**
 * The evidence ladder, strongest first. This is the ONLY ordering claim this
 * module makes, and each rung is a different statement about the token:
 *
 *   corroborated — the needle index found a candidate rowgroup in a raw file
 *                  overlapping this window. Two artifacts agree.
 *   bloom-hit    — the window's token bloom matched and did not overflow.
 *                  One artifact, one-sided guarantee, real signal.
 *   no-bloom     — the window has no bloom at all (older format, or the
 *                  ladder dropped it). Included so it is not silently
 *                  missed; it is not evidence.
 *   saturated    — the bloom overflowed, so it matches everything and prunes
 *                  nothing. Also not evidence, and it is the rung that
 *                  produces the flood, so it sinks.
 */
export type NeedleSignal = 'corroborated' | 'bloom-hit' | 'no-bloom' | 'saturated';

const SIGNAL_RANK: Record<NeedleSignal, number> = {
  corroborated: 0,
  'bloom-hit': 1,
  'no-bloom': 2,
  saturated: 3,
};

export const SIGNAL_LABEL: Record<NeedleSignal, string> = {
  corroborated: 'index-corroborated',
  'bloom-hit': 'bloom hit',
  'no-bloom': 'no bloom (maybe)',
  saturated: 'bloom saturated',
};

export const SIGNAL_EXPLAIN: Record<NeedleSignal, string> = {
  corroborated:
    'The bit-sliced needle index found a candidate rowgroup in a raw file overlapping this window — a second artifact agreeing with the bloom. Start here.',
  'bloom-hit':
    "The window's token bloom matched and had not overflowed. One-sided guarantee: a match may still be a false positive, an absence never is.",
  'no-bloom':
    'This window carries no token bloom (older format, or dropped by the retention ladder), so it is included as a maybe rather than silently missed. Not evidence.',
  saturated:
    'The bloom overflowed at write time, so it matches every token and prunes nothing. Its presence here says nothing about your token.',
};

/**
 * `candidate` outranks the bloom outright: it is the corroboration. Note the
 * deliberate asymmetry — a `candidate` verdict on a SATURATED window is still
 * corroborated, because the corroboration did not come from the bloom.
 */
export function signalOf(w: TokenWindow): NeedleSignal {
  if (w.needle === 'candidate') return 'corroborated';
  if (w.saturated) return 'saturated';
  return w.bloom_match ? 'bloom-hit' : 'no-bloom';
}

/** A run of contiguous same-verdict windows for one service. */
export interface NeedleRun {
  service: string;
  startNs: number;
  endNs: number;
  /** Source windows collapsed into this run (always ≥ 1). */
  windows: number;
  eventCount: number;
  signal: NeedleSignal;
  /** Every source window, in ascending time — the run's provenance. */
  members: TokenWindow[];
}

export interface NeedleGroup {
  service: string;
  runs: NeedleRun[];
  /** Source windows across the group. */
  windowCount: number;
  eventCount: number;
  /** Strongest verdict anywhere in the group — the group's rank. */
  best: NeedleSignal;
  /** Latest window end in the group — the recency tie-break. */
  latestNs: number;
}

function runOf(members: TokenWindow[]): NeedleRun {
  const first = members[0] as TokenWindow;
  return {
    service: first.service,
    startNs: first.window_start_ns,
    endNs: (members[members.length - 1] as TokenWindow).window_end_ns,
    windows: members.reduce((n, m) => n + Math.max(1, m.windows_merged || 1), 0),
    eventCount: members.reduce((n, m) => n + m.event_count, 0),
    signal: signalOf(first),
    members,
  };
}

/**
 * Group → collapse → rank. Pure: same input, same output, no clock.
 *
 * Contiguity is `previous.window_end_ns === next.window_start_ns`, the same
 * definition the alert engine uses for a consecutive-window run — an
 * adjacency the summariser actually produces, not a tolerance we invented.
 * Runs never span a verdict change: collapsing a corroborated window into a
 * saturated neighbour would relabel one of them, which is the opposite of
 * what this list is for.
 */
export function groupNeedleWindows(windows: TokenWindow[]): NeedleGroup[] {
  const byService = new Map<string, TokenWindow[]>();
  for (const w of windows) {
    const list = byService.get(w.service);
    if (list === undefined) byService.set(w.service, [w]);
    else list.push(w);
  }

  const groups: NeedleGroup[] = [];
  for (const [service, list] of byService) {
    const ascending = [...list].sort((a, b) => a.window_start_ns - b.window_start_ns);
    const runs: NeedleRun[] = [];
    let current: TokenWindow[] = [];
    for (const w of ascending) {
      const prev = current[current.length - 1];
      const contiguous =
        prev !== undefined && prev.window_end_ns === w.window_start_ns && signalOf(prev) === signalOf(w);
      if (contiguous) current.push(w);
      else {
        if (current.length > 0) runs.push(runOf(current));
        current = [w];
      }
    }
    if (current.length > 0) runs.push(runOf(current));

    // Strongest evidence first, then most recent — an investigator reads
    // down from "start here", and among equals the newest window wins.
    runs.sort((a, b) => SIGNAL_RANK[a.signal] - SIGNAL_RANK[b.signal] || b.startNs - a.startNs);
    groups.push({
      service,
      runs,
      windowCount: ascending.reduce((n, w) => n + Math.max(1, w.windows_merged || 1), 0),
      eventCount: ascending.reduce((n, w) => n + w.event_count, 0),
      best: (runs[0] as NeedleRun).signal,
      latestNs: ascending.reduce((n, w) => Math.max(n, w.window_end_ns), 0),
    });
  }

  groups.sort(
    (a, b) => SIGNAL_RANK[a.best] - SIGNAL_RANK[b.best] || b.latestNs - a.latestNs || a.service.localeCompare(b.service)
  );
  return groups;
}

/** Per-verdict window counts — the honest headline over the ranked list. */
export function signalTally(windows: TokenWindow[]): Record<NeedleSignal, number> {
  const tally: Record<NeedleSignal, number> = {
    corroborated: 0,
    'bloom-hit': 0,
    'no-bloom': 0,
    saturated: 0,
  };
  for (const w of windows) tally[signalOf(w)] += 1;
  return tally;
}

/**
 * The one-line "start here", or `null` when there is nothing to say (no
 * results). It names a service and the reason it is first — never a bare
 * imperative, because a ranking the operator cannot check is a ranking they
 * have to trust.
 */
export function startHere(groups: NeedleGroup[]): string | null {
  const first = groups[0];
  if (first === undefined) return null;
  const n = first.runs.filter((r) => r.signal === first.best).length;
  const plural = n === 1 ? '' : 's';
  switch (first.best) {
    case 'corroborated':
      return `Start with ${first.service} — ${n} index-corroborated run${plural} (the needle index agrees the token is in there).`;
    case 'bloom-hit':
      return `Start with ${first.service} — ${n} bloom hit${plural}; nothing in this result set is index-corroborated.`;
    case 'no-bloom':
      return `No window here is evidence: ${first.service} and the rest carry no token bloom, so they are listed as maybes. Most recent first.`;
    case 'saturated':
    default:
      return `Every window here has a SATURATED bloom, which prunes nothing — this list is "everything in range", not "everywhere the token is". Narrow the service or the time range.`;
  }
}
