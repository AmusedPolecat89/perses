// Copyright OBSESC Authors
//
// `AbortSignal.any([a, b])` without `AbortSignal.any` — the app's TS lib
// target predates it. Promoted here from IntegrityView (which had it) and
// FingerprintEpochCard (which had a second copy), and adopted by
// ObsescExploreView and InvestigateView.
//
// Two things the original copies got wrong and this one fixes:
//   - the SIBLING listener was never removed, so the losing signal (usually
//     an AbortSignal.timeout) pinned the controller and its closure for the
//     whole timeout;
//   - the abort REASON was dropped, so a composed timeout became
//     indistinguishable from an operator cancel downstream — exactly the
//     mislabel this lane is fixing in Integrity.

/**
 * A signal that aborts when EITHER input aborts, forwarding the winner's
 * reason. `a` may be undefined (a caller with no signal of its own), in
 * which case `b` is returned as-is.
 */
export function eitherSignal(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (a === undefined) return b;
  const ctl = new AbortController();
  if (a.aborted) {
    ctl.abort(a.reason);
    return ctl.signal;
  }
  if (b.aborted) {
    ctl.abort(b.reason);
    return ctl.signal;
  }
  const onA = (): void => {
    b.removeEventListener('abort', onB);
    ctl.abort(a.reason);
  };
  const onB = (): void => {
    a.removeEventListener('abort', onA);
    ctl.abort(b.reason);
  };
  a.addEventListener('abort', onA, { once: true });
  b.addEventListener('abort', onB, { once: true });
  return ctl.signal;
}
