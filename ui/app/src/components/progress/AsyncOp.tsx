// parity: CANONICAL — ui/perses/ui/app/src/components/progress/AsyncOp.tsx
// Copyright OBSESC Authors
//
// AsyncOpBar / AsyncOpStatus — the rendered half of the progress pattern.
//
// Dependency-free on purpose (react + ./useAsyncOp, nothing else): this
// file is duplicated byte-for-byte into the Module Federation plugin
// remote, which does not share @mui/material with the host app. Plain
// elements, inline styles, CSS custom properties with literal fallbacks —
// the convention every existing plugin file already follows. Kept honest
// by ui/e2e-obsesc/tests/progress-parity.spec.ts.
//
// Staged disclosure, driven by elapsed wall-clock:
//
//   0 ms     the trigger's label swaps to its running identity and gains
//            aria-busy / data-phase. NO DOM is inserted, so nothing can
//            shift and cost the user their NEXT click.
//   400 ms   a 2 px indeterminate bar becomes visible in a slot that is
//            always 2 px tall (its appearance costs zero layout).
//   2000 ms  elapsed counter, the op's scope detail, and Cancel.
//   deadline−5 s  elapsed turns amber and names the deadline.
//   done     the slot becomes a receipt ("ran in 4.2s · 312 rows") and
//            KEEPS it until the next run starts. A stale receipt with no
//            running state is unmistakable proof a click did nothing.
//
// Elapsed seconds, never a synthetic percentage: for almost every
// operation here no honest denominator exists, and a progress bar that
// invents one would be the only lie on a screen full of honesty chips.
// A determinate bar renders ONLY when the runner reports a true
// done/total.
//
// Accessibility: the live region carries PHASE TRANSITIONS ONLY. The
// elapsed counter ticks every 250 ms and is aria-hidden — inside a live
// region it would announce four times a second and make screen-reader UX
// worse, not better.

import { ReactElement, useEffect } from 'react';
import { AsyncOpState, DEADLINE_WARN_MS, OpPhase } from './useAsyncOp';

const ACCENT = 'var(--perses-colors-primary, #f59e0b)';
const WARN = '#b26a00';
const TRACK = 'rgba(127,127,127,0.18)';
const BAR_HEIGHT = 2;
const SLOT_MIN_HEIGHT = 28;

const STYLE_ID = 'obsesc-asyncop-style';
// Inline `style` attributes cannot hold keyframes or media queries, so the
// component injects exactly one id-guarded <style> per document.
const STYLE_TEXT = `
@keyframes obsesc-asyncop-slide {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(430%); }
}
.obsesc-asyncop-fill { animation: obsesc-asyncop-slide 1.15s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .obsesc-asyncop-fill {
    animation: none;
    transform: none;
    width: 100%;
    background-image: repeating-linear-gradient(
      135deg,
      rgba(255,255,255,0.55) 0 6px,
      rgba(255,255,255,0) 6px 12px
    );
  }
}
`;

function useAsyncOpStyle(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID) !== null) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = STYLE_TEXT;
    document.head.appendChild(el);
  }, []);
}

export function formatElapsed(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** Spread onto the trigger. It is NEVER disabled by its own in-flight work. */
export function asyncOpTriggerProps(state: AsyncOpState<unknown>): {
  'aria-busy': boolean;
  'data-phase': OpPhase;
} {
  return { 'aria-busy': state.phase === 'running', 'data-phase': state.phase };
}

/**
 * 2 px region-scoped activity bar in a permanently-reserved slot. One per
 * operating region (card / panel / drawer) — two stacked bars would
 * reflow, which is the thing this whole pattern exists to prevent.
 */
export function AsyncOpBar({ state, testId }: { state: AsyncOpState<unknown>; testId?: string }): ReactElement {
  useAsyncOpStyle();
  const p = state.progress;
  const determinate = p !== null && typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0;
  const pct = determinate ? Math.max(0, Math.min(100, ((p.done as number) / (p.total as number)) * 100)) : 0;
  return (
    <div
      data-testid={testId}
      data-phase={state.phase}
      aria-hidden="true"
      style={{
        height: BAR_HEIGHT,
        width: '100%',
        overflow: 'hidden',
        borderRadius: BAR_HEIGHT,
        background: state.showBar ? TRACK : 'transparent',
      }}
    >
      {state.showBar &&
        (determinate ? (
          <div
            style={{
              height: BAR_HEIGHT,
              width: `${pct}%`,
              background: ACCENT,
              transition: 'width 120ms linear',
            }}
          />
        ) : (
          <div className="obsesc-asyncop-fill" style={{ height: BAR_HEIGHT, width: '25%', background: ACCENT }} />
        ))}
    </div>
  );
}

export interface AsyncOpStatusProps {
  /** Stable id — renders as data-testid="asyncop-<id>". */
  id: string;
  state: AsyncOpState<unknown>;
  /** Omit for WRITES: aborting the fetch does not un-mint an epoch. */
  onCancel?: () => void;
  /** Shown at phase 'idle' (e.g. "Estimate first, or just run it."). */
  idleHint?: string;
  /** Op-specific running copy; defaults to "<label>…". */
  runningHint?: string;
  /** Noun for the receipt line, e.g. "Run". */
  label?: string;
}

function phaseMessage(props: AsyncOpStatusProps): string {
  const { state, label } = props;
  switch (state.phase) {
    case 'idle':
      return props.idleHint ?? '';
    case 'running':
      return props.runningHint ?? `${label ?? 'Working'}…`;
    case 'done': {
      const took = state.lastRunMs === null ? '' : ` in ${formatElapsed(state.lastRunMs)}`;
      return `✓ ran${took}${state.receipt !== null ? ` · ${state.receipt}` : ''}`;
    }
    case 'cancelled':
      // Honest: aborting the fetch drops the handler at its next await, but
      // any query-gate permit and ranged reads already issued are sunk.
      return `Stopped waiting after ${formatElapsed(state.elapsedMs)} — the node may still be finishing this scan.`;
    case 'timeout':
      return `No answer after ${formatElapsed(state.elapsedMs)} — the request timed out. The node may still be working.`;
    case 'error':
      return `✗ failed after ${formatElapsed(state.elapsedMs)}`;
    default:
      return '';
  }
}

/**
 * The reserved status slot: fixed minimum height so entering and leaving
 * the running state never reflows the surface underneath it.
 */
export function AsyncOpStatus(props: AsyncOpStatusProps): ReactElement {
  const { state, id, onCancel } = props;
  const running = state.phase === 'running';
  const nearDeadline = running && state.deadlineMs !== null && state.elapsedMs >= state.deadlineMs - DEADLINE_WARN_MS;
  const detail = running && state.showDetail ? (state.progress?.detail ?? null) : null;

  return (
    <div
      data-testid={`asyncop-${id}`}
      data-phase={state.phase}
      style={{
        minHeight: SLOT_MIN_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      {/* PHASE TRANSITIONS ONLY — no ticking numbers in the live region. */}
      <span role="status" aria-live="polite" style={{ opacity: 0.75 }}>
        {phaseMessage(props)}
      </span>
      {detail !== null && (
        <span aria-hidden="true" style={{ opacity: 0.65 }} data-testid={`asyncop-${id}-detail`}>
          {detail}
        </span>
      )}
      {running && state.showDetail && (
        <span
          aria-hidden="true"
          data-testid={`asyncop-${id}-elapsed`}
          style={{
            fontVariantNumeric: 'tabular-nums',
            opacity: nearDeadline ? 1 : 0.65,
            color: nearDeadline ? WARN : undefined,
          }}
        >
          {formatElapsed(state.elapsedMs)}
          {nearDeadline && state.deadlineMs !== null ? ` · times out at ${Math.round(state.deadlineMs / 1000)}s` : ''}
        </span>
      )}
      {running && state.showDetail && onCancel !== undefined && (
        <button
          type="button"
          onClick={onCancel}
          data-testid={`asyncop-${id}-cancel`}
          style={{
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 4,
            border: '1px solid rgba(127,127,127,0.4)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      )}
    </div>
  );
}
