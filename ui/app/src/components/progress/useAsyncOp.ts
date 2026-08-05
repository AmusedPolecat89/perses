// parity: CANONICAL — ui/perses/ui/app/src/components/progress/useAsyncOp.ts
// Copyright OBSESC Authors
//
// useAsyncOp — ONE hook instance per user-triggered async operation.
//
// This module is deliberately dependency-free (it imports `react` and
// nothing else) because it is duplicated byte-for-byte into the Module
// Federation plugin remote, which does not share @mui/material with the
// host app. The duplicate is kept honest by
// ui/e2e-obsesc/tests/progress-parity.spec.ts — edit the CANONICAL copy,
// then copy it verbatim to the mirror.
//
// The invariants below each close a bug that existed in this codebase:
//
//  1. GENERATION GUARD — every run() bumps a generation; every state write
//     is gated on it. Closes the stale-response race where a slower OLDER
//     search overwrote a newer one (ObsescExploreView needle search).
//  2. SUPERSEDE, NEVER BLOCK — a control is never `disabled` because work
//     is in flight. A disabled control swallows the click silently, which
//     is the entire U5 failure class. Re-running aborts the previous
//     generation instead.
//  3. CROSS-OP INDEPENDENCE — one instance per operation; nothing consults
//     another op's phase. (U5's actual instance: one `busy` token shared by
//     Estimate and Run, so Estimate disabled Run.)
//  4. TIMEOUT ≠ CANCEL — the deadline lives in the hook and aborts with a
//     distinguishable reason, so a timeout is never reported to the
//     operator as something they did.
//  5. UNMOUNT ABORTS and writes no state.
//  6. ELAPSED IS DERIVED FROM performance.now(), never accumulated — a
//     background-throttled tab (interval clamped to >= 1 s) still reports
//     true wall-clock, and a Date.now() jump cannot corrupt it.
//  7. THE RECEIPT CLEARS AT RUN START — a stale receipt must never be
//     mistakable for the new run's result. (It is also what makes a lost
//     click self-evident: a stale receipt with no running state.)
//  8. AN ABORT CAUSED BY SUPERSEDE IS NOT AN ERROR.
//  9. IDENTICAL ARGS INSIDE debounceIdenticalMs ARE A NO-OP — bounds the
//     cost of invariant 2.
//
// Progress is reported in TRUE units only. There is no synthetic
// percentage anywhere in here: when no honest denominator exists the UI
// shows elapsed seconds, which is a measurement rather than an invention.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type OpPhase = 'idle' | 'running' | 'done' | 'error' | 'cancelled' | 'timeout';

/** Real progress. `done`/`total` are present ONLY when a true denominator exists. */
export interface OpProgress {
  done?: number;
  total?: number;
  /** e.g. "1,204 summary files consulted · 63 candidate windows" */
  detail?: string;
}

export interface OpCtx {
  signal: AbortSignal;
  report: (p: OpProgress) => void;
}

export interface AsyncOpState<T> {
  phase: OpPhase;
  /** performance.now() delta, refreshed on a 250 ms tick while running. */
  elapsedMs: number;
  /** Duration of the last COMPLETED run (phase 'done'), in ms. */
  lastRunMs: number | null;
  /** Caller-supplied, e.g. "312 rows" — rendered as "ran in 4.2s · 312 rows". */
  receipt: string | null;
  data: T | null;
  error: string | null;
  progress: OpProgress | null;
  /** elapsedMs >= 400 while running — the anti-flicker threshold for the bar. */
  showBar: boolean;
  /** elapsedMs >= 2000 while running — elapsed counter, detail and Cancel. */
  showDetail: boolean;
  /** This op's own deadline, so the status line never quotes a shared constant. */
  deadlineMs: number | null;
}

export interface AsyncOpOptions {
  /** Running identity of the control, e.g. "Run". */
  label: string;
  /** Hard deadline; arms an abort that reports as 'timeout', never 'cancelled'. */
  timeoutMs?: number;
  /** Identical args re-run inside this window are a no-op. Default 300 ms. */
  debounceIdenticalMs?: number;
}

export interface AsyncOpHandle<T, A extends unknown[]> {
  state: AsyncOpState<T>;
  run: (...args: A) => void;
  cancel: () => void;
  reset: () => void;
}

/** Below the ~1 s flow limit: sub-400 ms operations must insert NO DOM. */
export const BAR_THRESHOLD_MS = 400;
/** Where a user starts asking "is it stuck" — elapsed + Cancel earn their pixels. */
export const DETAIL_THRESHOLD_MS = 2000;
export const TICK_MS = 250;
export const DEFAULT_DEBOUNCE_MS = 300;
/** The deadline warning turns amber this long before the timeout fires. */
export const DEADLINE_WARN_MS = 5000;

type AbortKind = 'cancelled' | 'timeout' | 'superseded' | 'unmounted';

interface AsyncOpAbortReason {
  obsescAbort: AbortKind;
}

function abortReason(kind: AbortKind): AsyncOpAbortReason {
  return { obsescAbort: kind };
}

/** The abort kind carried by `signal.reason`, or null if not one of ours. */
export function abortKindOf(reason: unknown): 'cancelled' | 'timeout' | 'superseded' | 'unmounted' | null {
  if (typeof reason !== 'object' || reason === null || !('obsescAbort' in reason)) return null;
  const kind = (reason as { obsescAbort: unknown }).obsescAbort;
  return kind === 'cancelled' || kind === 'timeout' || kind === 'superseded' || kind === 'unmounted' ? kind : null;
}

/** True when `e` is an abort of any provenance (ours, DOM, or a composed timeout). */
export function isAbortLike(e: unknown): boolean {
  if (abortKindOf(e) !== null) return true;
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function argsKey(args: unknown[]): string | null {
  try {
    return JSON.stringify(args);
  } catch {
    // Circular / non-serialisable args: never debounce rather than guess.
    return null;
  }
}

interface CoreState<T> {
  phase: OpPhase;
  elapsedMs: number;
  lastRunMs: number | null;
  receipt: string | null;
  data: T | null;
  error: string | null;
  progress: OpProgress | null;
}

function idleCore<T>(): CoreState<T> {
  return {
    phase: 'idle',
    elapsedMs: 0,
    lastRunMs: null,
    receipt: null,
    data: null,
    error: null,
    progress: null,
  };
}

interface RunRecord {
  gen: number;
  ctl: AbortController;
  /** Set BEFORE ctl.abort() so the catch never has to guess why. */
  kind: AbortKind | null;
  start: number;
}

export function useAsyncOp<T, A extends unknown[]>(
  runner: (ctx: OpCtx, ...args: A) => Promise<{ data: T; receipt?: string }>,
  opts: AsyncOpOptions
): AsyncOpHandle<T, A> {
  const timeoutMs = opts.timeoutMs ?? null;
  const debounceMs = opts.debounceIdenticalMs ?? DEFAULT_DEBOUNCE_MS;

  const [core, setCore] = useState<CoreState<T>>(idleCore<T>);

  // The runner closes over render state, so always invoke the latest one.
  const runnerRef = useRef(runner);
  useEffect(() => {
    runnerRef.current = runner;
  });

  const genRef = useRef(0);
  const activeRef = useRef<RunRecord | null>(null);
  const mountedRef = useRef(true);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastArgsRef = useRef<{ key: string; at: number } | null>(null);

  const clearTimers = useCallback((): void => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      const rec = activeRef.current;
      if (rec !== null) {
        rec.kind = 'unmounted';
        rec.ctl.abort(abortReason('unmounted'));
      }
      activeRef.current = null;
      clearTimers();
    };
  }, [clearTimers]);

  const run = useCallback(
    (...args: A): void => {
      const now = performance.now();
      const key = argsKey(args);
      if (
        key !== null &&
        debounceMs > 0 &&
        lastArgsRef.current !== null &&
        lastArgsRef.current.key === key &&
        now - lastArgsRef.current.at < debounceMs
      ) {
        return;
      }
      if (key !== null) lastArgsRef.current = { key, at: now };

      // Supersede — never block. The previous generation's rejection is
      // discarded by the generation guard, so it writes nothing.
      const prev = activeRef.current;
      if (prev !== null) {
        prev.kind = 'superseded';
        prev.ctl.abort(abortReason('superseded'));
      }
      clearTimers();

      const gen = ++genRef.current;
      const ctl = new AbortController();
      const rec: RunRecord = { gen, ctl, kind: null, start: now };
      activeRef.current = rec;

      const live = (): boolean => mountedRef.current && genRef.current === gen;

      // Invariant 7: the receipt goes at run start. Previous `data` is kept
      // (callers dim it as stale) so the surface never blanks for seconds.
      setCore((s) => ({
        phase: 'running',
        elapsedMs: 0,
        lastRunMs: s.lastRunMs,
        receipt: null,
        data: s.data,
        error: null,
        progress: null,
      }));

      const tick = (): void => {
        if (!live()) return;
        setCore((s) => (s.phase === 'running' ? { ...s, elapsedMs: performance.now() - rec.start } : s));
      };
      // Dedicated wake-ups so the thresholds land ON 400/2000 ms rather than
      // on the next 250 ms tick after them.
      timersRef.current.push(setTimeout(tick, BAR_THRESHOLD_MS));
      timersRef.current.push(setTimeout(tick, DETAIL_THRESHOLD_MS));
      tickRef.current = setInterval(tick, TICK_MS);
      if (timeoutMs !== null) {
        timersRef.current.push(
          setTimeout(() => {
            if (rec.kind !== null) return;
            rec.kind = 'timeout';
            rec.ctl.abort(abortReason('timeout'));
          }, timeoutMs)
        );
      }

      const settle = (next: Partial<CoreState<T>> & { phase: OpPhase }): void => {
        clearTimers();
        if (activeRef.current === rec) activeRef.current = null;
        const elapsed = performance.now() - rec.start;
        setCore((s) => ({
          ...s,
          ...next,
          elapsedMs: elapsed,
          lastRunMs: next.phase === 'done' ? elapsed : s.lastRunMs,
        }));
      };

      const report = (p: OpProgress): void => {
        if (!live()) return;
        setCore((s) => (s.phase === 'running' ? { ...s, progress: { ...s.progress, ...p } } : s));
      };

      // NOTE: the runner is invoked synchronously — there is no `await`
      // before it — so the request leaves the browser in the same task as
      // the click. `phase === 'running'` therefore always implies a request
      // was issued, which is what made U5's diagnosis decidable.
      void (async (): Promise<void> => {
        try {
          const out = await runnerRef.current({ signal: ctl.signal, report }, ...args);
          if (!live()) return;
          settle({ phase: 'done', data: out.data, receipt: out.receipt ?? null, error: null });
        } catch (e) {
          if (!live()) return;
          const kind = rec.kind ?? abortKindOf(ctl.signal.reason) ?? abortKindOf(e);
          if (kind === 'timeout' || (e as { name?: unknown } | null)?.name === 'TimeoutError') {
            settle({ phase: 'timeout', error: null });
          } else if (kind === 'cancelled') {
            settle({ phase: 'cancelled', error: null });
          } else if (isAbortLike(e)) {
            // An abort nobody here asked for (a caller-composed signal):
            // report it as a timeout rather than blaming the operator.
            settle({ phase: 'timeout', error: null });
          } else {
            settle({ phase: 'error', error: String(e) });
          }
        }
      })();
    },
    [clearTimers, debounceMs, timeoutMs]
  );

  const cancel = useCallback((): void => {
    const rec = activeRef.current;
    if (rec === null) return;
    rec.kind = 'cancelled';
    rec.ctl.abort(abortReason('cancelled'));
    // Retire the generation: a runner that swallows its abort must not be
    // able to write a result after the operator stopped waiting.
    genRef.current += 1;
    activeRef.current = null;
    clearTimers();
    const elapsed = performance.now() - rec.start;
    setCore((s) => ({ ...s, phase: 'cancelled', elapsedMs: elapsed, error: null }));
  }, [clearTimers]);

  const reset = useCallback((): void => {
    const rec = activeRef.current;
    if (rec !== null) {
      rec.kind = 'cancelled';
      rec.ctl.abort(abortReason('cancelled'));
    }
    genRef.current += 1;
    activeRef.current = null;
    lastArgsRef.current = null;
    clearTimers();
    setCore(idleCore<T>());
  }, [clearTimers]);

  const state = useMemo<AsyncOpState<T>>(
    () => ({
      ...core,
      showBar: core.phase === 'running' && core.elapsedMs >= BAR_THRESHOLD_MS,
      showDetail: core.phase === 'running' && core.elapsedMs >= DETAIL_THRESHOLD_MS,
      deadlineMs: timeoutMs,
    }),
    [core, timeoutMs]
  );

  return { state, run, cancel, reset };
}

function trackedErrorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : String(error);
}

function trackedPhase(active: boolean, errorText: string | null, lastRunMs: number | null): OpPhase {
  if (active) return 'running';
  if (errorText !== null) return 'error';
  return lastRunMs !== null ? 'done' : 'idle';
}

/**
 * The same staged disclosure for work this hook does NOT own — a
 * react-query panel mount, a mutation. `active` is the caller's
 * isFetching/isLoading; everything else is derived here so panel-mount
 * waits get the identical bar/elapsed/receipt treatment.
 */
export function useTrackedOp(
  active: boolean,
  opts?: { timeoutMs?: number; error?: unknown; receipt?: string | null }
): AsyncOpState<null> {
  const startRef = useRef<number | null>(null);
  const lastRunRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!active) {
      if (startRef.current !== null) {
        lastRunRef.current = performance.now() - startRef.current;
        startRef.current = null;
        setElapsedMs(0);
      }
      return;
    }
    const start = performance.now();
    startRef.current = start;
    const bump = (): void => setElapsedMs(performance.now() - start);
    const timers = [setTimeout(bump, BAR_THRESHOLD_MS), setTimeout(bump, DETAIL_THRESHOLD_MS)];
    const interval = setInterval(bump, TICK_MS);
    return (): void => {
      for (const t of timers) clearTimeout(t);
      clearInterval(interval);
    };
  }, [active]);

  const errorText = trackedErrorText(opts?.error);
  const phase = trackedPhase(active, errorText, lastRunRef.current);

  return {
    phase,
    elapsedMs: active ? elapsedMs : 0,
    lastRunMs: lastRunRef.current,
    receipt: opts?.receipt ?? null,
    data: null,
    error: errorText,
    progress: null,
    showBar: active && elapsedMs >= BAR_THRESHOLD_MS,
    showDetail: active && elapsedMs >= DETAIL_THRESHOLD_MS,
    deadlineMs: opts?.timeoutMs ?? null,
  };
}
