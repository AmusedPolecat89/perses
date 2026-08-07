// Copyright OBSESC Authors
//
// U11 — the shared time model.
//
// The whole unification rests on one claim: OUR encoding of a time range and
// PERSES' encoding of a time range are the same bytes in the same two query
// params. Nothing in TypeScript checks that (the params are strings on a URL,
// read by a package we do not compile against here), so it is pinned by test.
//
// The reference is @perses-dev/plugin-system
// runtime/TimeRangeProvider/query-params.ts:
//
//   encodeTimeRangeValue: a DurationString passes through verbatim;
//                         a Date becomes `getUnixTime(d) * 1000` — SECONDS,
//                         multiplied back up, so sub-second precision is
//                         dropped by construction.
//   decodeTimeRangeValue: `isDurationString(s) ? s : new Date(Number(s))`.
//   useInitialTimeRange:  `start` alone ⇒ relative; `start` + `end` as dates
//                         ⇒ absolute; no `start` ⇒ the dashboard's duration.

import {
  DEFAULT_RANGE,
  DURATION_REGEX,
  decodeRange,
  encodeRange,
  isDurationString,
  isoSeconds,
  localInputToMs,
  msToLocalInput,
  parseDuration,
  rangeKey,
  rangeLabel,
  rangesEqual,
  resolveRange,
} from './time-range';

describe('duration strings match the Perses grammar', () => {
  it('is the transcribed upstream regex', () => {
    // If this literal ever drifts from @perses-dev/spec common/duration.ts,
    // a range this UI writes stops being a range a dashboard can read.
    expect(DURATION_REGEX.source).toBe(
      '^(?:(\\d+)y)?(?:(\\d+)w)?(?:(\\d+)d)?(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?(?:(\\d+)ms)?$'
    );
  });

  it.each([
    ['15m', 15 * 60_000],
    ['1h', 3_600_000],
    ['6h', 6 * 3_600_000],
    ['24h', 24 * 3_600_000],
    ['7d', 7 * 86_400_000],
    ['1h30m', 5_400_000],
    ['500ms', 500],
  ])('parses %s', (s, ms) => {
    expect(parseDuration(s)).toBe(ms);
  });

  it('rejects the empty string, which the upstream regex ACCEPTS', () => {
    // Every group is optional, so `DURATION_REGEX.test('')` is true. An
    // empty `start` param would otherwise decode to a zero-width relative
    // range and silently query nothing.
    expect(DURATION_REGEX.test('')).toBe(true);
    expect(isDurationString('')).toBe(false);
    expect(decodeRange('', null)).toBeNull();
  });

  it('rejects out-of-order and non-duration text', () => {
    expect(isDurationString('30m1h')).toBe(false);
    expect(isDurationString('last hour')).toBe(false);
  });
});

describe('the start/end param encoding', () => {
  it('writes a relative range as start alone, with no end', () => {
    expect(encodeRange({ kind: 'relative', duration: '6h' })).toEqual({ start: '6h' });
  });

  it('writes an absolute range as two epoch-ms literals', () => {
    expect(encodeRange({ kind: 'absolute', startMs: 1_754_500_000_000, endMs: 1_754_503_600_000 })).toEqual({
      start: '1754500000000',
      end: '1754503600000',
    });
  });

  it('floors absolute instants to whole seconds, exactly as Perses does', () => {
    // Perses encodes with getUnixTime() — seconds — so sub-second precision
    // cannot survive a round trip through the URL. Emitting it anyway would
    // leave our writer and theirs disagreeing on every render.
    expect(encodeRange({ kind: 'absolute', startMs: 1_754_500_000_123, endMs: 1_754_503_600_987 })).toEqual({
      start: '1754500000000',
      end: '1754503600000',
    });
  });

  it.each([
    ['1h', null],
    ['15m', null],
    ['7d', null],
  ])('round trips the relative range %s', (start) => {
    const decoded = decodeRange(start, null);
    expect(decoded).toEqual({ kind: 'relative', duration: start });
    expect(encodeRange(decoded!).start).toBe(start);
  });

  it('round trips an absolute range', () => {
    const range = { kind: 'absolute' as const, startMs: 1_754_500_000_000, endMs: 1_754_503_600_000 };
    const p = encodeRange(range);
    expect(decodeRange(p.start, p.end ?? null)).toEqual(range);
  });

  it('decodes nothing usable to null rather than to a default', () => {
    // A nav link simply drops the query string. "No params" must mean "keep
    // whatever range we already had", never "silently reset the window".
    expect(decodeRange(null, null)).toBeNull();
    expect(decodeRange('1754500000000', null)).toBeNull(); // absolute needs both
    expect(decodeRange('nonsense', 'nonsense')).toBeNull();
  });

  it('rejects an inverted or empty absolute window', () => {
    expect(decodeRange('1754503600000', '1754500000000')).toBeNull();
    expect(decodeRange('1754500000000', '1754500000000')).toBeNull();
  });
});

describe('resolution is against a supplied clock, never an implicit one', () => {
  const now = 1_754_503_600_000;

  it('resolves a relative range at the moment it is asked', () => {
    const r = resolveRange({ kind: 'relative', duration: '1h' }, now);
    expect(r.toMs).toBe(now);
    expect(r.fromMs).toBe(now - 3_600_000);
    expect(r.toNs).toBe(now * 1e6);
    expect(r.fromNs).toBe((now - 3_600_000) * 1e6);
  });

  it('leaves an absolute range alone whatever the clock says', () => {
    const range = { kind: 'absolute' as const, startMs: 1_000_000_000_000, endMs: 1_000_003_600_000 };
    expect(resolveRange(range, now)).toEqual(resolveRange(range, now + 86_400_000));
  });

  it('falls back to the default span for a duration it cannot parse', () => {
    // Reached only via a hand-edited URL; a NaN bound would be sent to the
    // node as `from_ns=NaN`, which is a 400 the operator cannot diagnose.
    const r = resolveRange({ kind: 'relative', duration: 'garbage' }, now);
    expect(r.fromMs).toBe(now - (parseDuration(DEFAULT_RANGE.duration) as number));
    expect(Number.isFinite(r.fromNs)).toBe(true);
  });
});

describe('identity and labels', () => {
  it('keys equal ranges the same and unequal ranges differently', () => {
    expect(rangeKey({ kind: 'relative', duration: '1h' })).toBe('1h');
    expect(rangesEqual({ kind: 'relative', duration: '1h' }, { kind: 'relative', duration: '1h' })).toBe(true);
    expect(rangesEqual({ kind: 'relative', duration: '1h' }, { kind: 'relative', duration: '6h' })).toBe(false);
    expect(rangesEqual(null, null)).toBe(true);
    expect(rangesEqual(null, { kind: 'relative', duration: '1h' })).toBe(false);
  });

  it('labels a preset by its name and an absolute range by its bounds', () => {
    expect(rangeLabel({ kind: 'relative', duration: '6h' })).toBe('Last 6 hours');
    expect(rangeLabel({ kind: 'relative', duration: '90m' })).toBe('Last 90m');
    expect(rangeLabel({ kind: 'absolute', startMs: 0, endMs: 3_600_000 })).toBe(
      '1970-01-01 00:00:00 → 1970-01-01 01:00:00 UTC'
    );
  });

  it('prints seconds-precision UTC, never a raw epoch', () => {
    expect(isoSeconds(1_754_503_600_000)).toBe('2025-08-06 18:06:40');
    expect(isoSeconds(Number.NaN)).toBe('—');
  });
});

describe('the datetime-local bridge', () => {
  it('round trips through the browser zone', () => {
    // TZ=UTC in the jest script, so local == UTC here; the property that
    // matters is that the pair is each other's inverse.
    const ms = 1_754_503_600_000;
    expect(localInputToMs(msToLocalInput(ms))).toBe(ms);
  });

  it('reports a half-typed field as null rather than NaN', () => {
    expect(localInputToMs('')).toBeNull();
    expect(localInputToMs('not-a-date')).toBeNull();
  });
});
