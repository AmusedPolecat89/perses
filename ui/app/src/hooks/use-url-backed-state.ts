// Copyright OBSESC Authors
//
// B3.5 — investigation inputs must survive a reload and travel in a link.
//
// The Explore and Investigate views used to hold their inputs (the SQL
// text, the needle token, the service filter, the baseline pin) in bare
// React state: reloading the tab destroyed the investigation and "look at
// this" in an incident channel was impossible. The shared TIME range was
// already URL-synced (use-time-range-url.ts); this hook does the same for
// the per-view inputs, so the URL is the whole investigation and
// `location.href` is the permalink (see CopyLinkButton).
//
// Semantics — deliberately narrower than the time mirror:
//
//   read   once, at mount: the URL is a RESTORE POINT, not a live channel.
//          Back/forward re-mounting the view re-reads it; a param change
//          under a mounted view does not fight the operator's typing.
//
//   write  debounced, `replace: true`: the input is a view of the page,
//          not a page in the history — pushing would make Back walk
//          through every keystroke. The debounce keeps a fast typist from
//          re-rendering every useSearchParams subscriber per keystroke.
//
//   ''     means "absent": an empty input deletes its param rather than
//          littering the permalink with `&sql=`.
//
// What is deliberately NOT restored: fetched results. A permalink restores
// the question; the recipient presses Run/Search themselves, so a scan is
// never triggered by merely opening a link (the same reason the SQL box
// never auto-runs — the scan-gate ethos is "the operator asks").

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const WRITE_DELAY_MS = 300;

/**
 * A string input mirrored into the `key` query param. `fallback` seeds the
 * state when the URL carries nothing (lazy form supported, same as
 * `useState`).
 */
export function useUrlBackedState(
  key: string,
  fallback: string | (() => string)
): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const [value, setValue] = useState<string>(() => {
    const fromUrl = params.get(key);
    if (fromUrl !== null && fromUrl !== '') return fromUrl;
    return typeof fallback === 'function' ? fallback() : fallback;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);

  const write = useCallback(
    (v: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v === '') next.delete(key);
          else next.set(key, v);
          return next;
        },
        { replace: true }
      );
    },
    [key, setParams]
  );

  const set = useCallback(
    (v: string) => {
      setValue(v);
      latest.current = v;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        write(latest.current);
      }, WRITE_DELAY_MS);
    },
    [write]
  );

  // A pending write must not fire after unmount: the view it belongs to is
  // gone and the params now describe some other route.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  return [value, set];
}
