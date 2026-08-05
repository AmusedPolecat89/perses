// Copyright OBSESC Authors
//
// Unit coverage for useAsyncOp — every case here pins one of the hook's
// stated invariants, and each invariant closes a bug that existed in this
// codebase before this lane (shared busy token, stale-response race,
// timeout mislabelled as an operator cancel).

import { act, renderHook } from '@testing-library/react';
import { BAR_THRESHOLD_MS, DETAIL_THRESHOLD_MS, OpCtx, useAsyncOp } from './useAsyncOp';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush microtasks without advancing the fake clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useAsyncOp — anti-flicker thresholds', () => {
  it('a sub-400 ms operation never crosses either threshold', async () => {
    const d = deferred<{ data: string }>();
    const { result } = renderHook(() => useAsyncOp<string, []>(() => d.promise, { label: 'Fast' }));

    act(() => result.current.run());
    expect(result.current.state.phase).toBe('running');
    expect(result.current.state.showBar).toBe(false);

    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(result.current.state.showBar).toBe(false);
    expect(result.current.state.showDetail).toBe(false);

    d.resolve({ data: 'ok' });
    await flush();
    expect(result.current.state.phase).toBe('done');
    // Never inserted: an op this fast must cost zero layout.
    expect(result.current.state.showBar).toBe(false);
    expect(result.current.state.showDetail).toBe(false);
  });

  it('showBar flips at exactly 400 ms and showDetail at exactly 2000 ms', () => {
    const d = deferred<{ data: string }>();
    const { result } = renderHook(() => useAsyncOp<string, []>(() => d.promise, { label: 'Slow' }));

    act(() => result.current.run());
    act(() => {
      jest.advanceTimersByTime(BAR_THRESHOLD_MS - 1);
    });
    expect(result.current.state.showBar).toBe(false);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.state.showBar).toBe(true);
    expect(result.current.state.showDetail).toBe(false);

    act(() => {
      jest.advanceTimersByTime(DETAIL_THRESHOLD_MS - BAR_THRESHOLD_MS - 1);
    });
    expect(result.current.state.showDetail).toBe(false);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.state.showDetail).toBe(true);
  });
});

describe('useAsyncOp — elapsed is derived, never accumulated', () => {
  it('a background gap that delivers one tick still reports true wall-clock', () => {
    // A throttled background tab clamps setInterval to >= 1 s, so the
    // ticker fires far fewer times than 250 ms would suggest. Elapsed is a
    // performance.now() delta, so one tick after a 5 s gap reads ~5000 —
    // an accumulator would read 250.
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);

    const d = deferred<{ data: string }>();
    const { result } = renderHook(() => useAsyncOp<string, []>(() => d.promise, { label: 'Slow' }));

    act(() => result.current.run());
    clock = 5000;
    act(() => {
      jest.advanceTimersByTime(250);
    });
    expect(result.current.state.elapsedMs).toBe(5000);
  });
});

describe('useAsyncOp — supersede, never block', () => {
  it('a second run aborts the first and only the second writes state', async () => {
    const first = deferred<{ data: string }>();
    const second = deferred<{ data: string }>();
    const signals: AbortSignal[] = [];
    let call = 0;
    const { result } = renderHook(() =>
      useAsyncOp<string, [string]>(
        (ctx: OpCtx) => {
          signals.push(ctx.signal);
          call += 1;
          return call === 1 ? first.promise : second.promise;
        },
        { label: 'Run' }
      )
    );

    act(() => result.current.run('a'));
    act(() => result.current.run('b'));
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    // The superseded generation resolving late must write nothing.
    second.resolve({ data: 'B' });
    await flush();
    expect(result.current.state.data).toBe('B');

    first.resolve({ data: 'A' });
    await flush();
    expect(result.current.state.data).toBe('B');
    expect(result.current.state.phase).toBe('done');
  });

  it('a superseded abort never renders an error state', async () => {
    const first = deferred<{ data: string }>();
    const second = deferred<{ data: string }>();
    let call = 0;
    const { result } = renderHook(() =>
      useAsyncOp<string, [string]>(
        async (ctx: OpCtx) => {
          call += 1;
          const p = call === 1 ? first.promise : second.promise;
          const out = await p;
          if (ctx.signal.aborted) throw ctx.signal.reason;
          return out;
        },
        { label: 'Run' }
      )
    );

    act(() => result.current.run('a'));
    act(() => result.current.run('b'));
    first.resolve({ data: 'A' });
    await flush();
    expect(result.current.state.phase).toBe('running');
    expect(result.current.state.error).toBeNull();
  });
});

describe('useAsyncOp — timeout is not a cancel', () => {
  it('the deadline reports phase "timeout"', async () => {
    const d = deferred<{ data: string }>();
    const { result } = renderHook(() =>
      useAsyncOp<string, []>(
        async (ctx: OpCtx) => {
          const out = await d.promise;
          if (ctx.signal.aborted) throw ctx.signal.reason;
          return out;
        },
        { label: 'Verify', timeoutMs: 1000 }
      )
    );

    act(() => result.current.run());
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    d.resolve({ data: 'late' });
    await flush();
    expect(result.current.state.phase).toBe('timeout');
    expect(result.current.state.data).toBeNull();
  });

  it('an operator cancel reports phase "cancelled"', () => {
    const d = deferred<{ data: string }>();
    const { result } = renderHook(() =>
      useAsyncOp<string, []>(() => d.promise, { label: 'Verify', timeoutMs: 60_000 })
    );

    act(() => result.current.run());
    act(() => result.current.cancel());
    expect(result.current.state.phase).toBe('cancelled');
  });
});

describe('useAsyncOp — lifecycle', () => {
  it('unmount aborts the in-flight run and writes no state', async () => {
    const errors: unknown[] = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));

    const d = deferred<{ data: string }>();
    let signal: AbortSignal | null = null;
    const { result, unmount } = renderHook(() =>
      useAsyncOp<string, []>(
        (ctx: OpCtx) => {
          signal = ctx.signal;
          return d.promise;
        },
        { label: 'Run' }
      )
    );

    act(() => result.current.run());
    unmount();
    expect(signal!.aborted).toBe(true);

    d.resolve({ data: 'late' });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // A setState after unmount would surface here as an act()/update warning.
    expect(errors).toHaveLength(0);
  });

  it('clears the receipt at run start and sets lastRunMs only on done', async () => {
    const first = deferred<{ data: string; receipt: string }>();
    const second = deferred<{ data: string; receipt: string }>();
    let call = 0;
    const { result } = renderHook(() =>
      useAsyncOp<string, [string]>(
        () => {
          call += 1;
          return call === 1 ? first.promise : second.promise;
        },
        { label: 'Run' }
      )
    );

    act(() => result.current.run('a'));
    expect(result.current.state.lastRunMs).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    first.resolve({ data: 'A', receipt: '312 rows' });
    await flush();
    expect(result.current.state.receipt).toBe('312 rows');
    expect(result.current.state.lastRunMs).toBeGreaterThanOrEqual(1000);

    // A stale receipt must never be mistakable for the new run's result.
    act(() => result.current.run('b'));
    expect(result.current.state.receipt).toBeNull();
  });
});

describe('useAsyncOp — identical-args debounce', () => {
  it('an identical immediate re-run is a no-op', () => {
    const d = deferred<{ data: string }>();
    const runner = jest.fn(() => d.promise);
    const { result } = renderHook(() => useAsyncOp<string, [string]>(runner, { label: 'Run' }));

    act(() => result.current.run('same'));
    act(() => result.current.run('same'));
    expect(runner).toHaveBeenCalledTimes(1);

    // Different args always supersede, whatever the window.
    act(() => result.current.run('other'));
    expect(runner).toHaveBeenCalledTimes(2);

    // Past the window, the identical run goes through again.
    act(() => {
      jest.advanceTimersByTime(400);
    });
    act(() => result.current.run('other'));
    expect(runner).toHaveBeenCalledTimes(3);
  });
});
