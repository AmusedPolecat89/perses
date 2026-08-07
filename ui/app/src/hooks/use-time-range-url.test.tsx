// Copyright OBSESC Authors
//
// U11 — the range has to SURVIVE the jump between surfaces.
//
// The two directions are asymmetric and both are load-bearing:
//
//   URL → store  is how a dashboard picker change reaches Explore and
//                Investigate (Perses writes `start`/`end`, nothing else).
//   store → URL  is how a range chosen in Explore reaches a dashboard, and
//                the reason a Perses nav link dropping the query string does
//                not silently reset the investigation's window.
//
// The seeding hook is the ordering half: `useInitialTimeRange` reads the
// params during ViewDashboard's FIRST render, so an effect that fixes the
// URL afterwards loses to Perses' own writer.

import { ReactElement, useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { readSharedTimeRange, resetSharedTimeRange, setSharedTimeRange } from './use-shared-time-range';
import { useSeedDashboardTimeParams, useTimeRangeUrlMirror } from './use-time-range-url';

beforeEach(() => {
  resetSharedTimeRange();
});

/** Renders the mirror and exposes the live query string for assertions. */
function Mirror(): ReactElement {
  useTimeRangeUrlMirror();
  const location = useLocation();
  return <span data-testid="search">{location.search}</span>;
}

function renderMirror(initial: string): void {
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Mirror />
    </MemoryRouter>
  );
}

function search(): string {
  return screen.getByTestId('search').textContent ?? '';
}

describe('URL → store', () => {
  it('adopts a relative range a dashboard picker wrote', () => {
    renderMirror('/projects/my-project/dashboards/nodehealth?start=6h');
    expect(readSharedTimeRange()).toEqual({ kind: 'relative', duration: '6h' });
  });

  it('adopts an absolute range', () => {
    renderMirror('/x?start=1754500000000&end=1754503600000');
    expect(readSharedTimeRange()).toEqual({
      kind: 'absolute',
      startMs: 1_754_500_000_000,
      endMs: 1_754_503_600_000,
    });
  });

  it('does NOT clear the range when a nav link drops the query string', () => {
    // This is the whole finding: crossing sections used to mean re-entering
    // the window by hand. An absent param means "unchanged", never "reset".
    setSharedTimeRange({ kind: 'relative', duration: '24h' });
    renderMirror('/explore');
    expect(readSharedTimeRange()).toEqual({ kind: 'relative', duration: '24h' });
  });

  it('ignores an undecodable param instead of blanking the range', () => {
    setSharedTimeRange({ kind: 'relative', duration: '24h' });
    renderMirror('/explore?start=not-a-duration');
    expect(readSharedTimeRange()).toEqual({ kind: 'relative', duration: '24h' });
  });
});

describe('store → URL', () => {
  it('writes nothing at all until a range has actually been chosen', () => {
    // A cold session must leave a dashboard's authored duration alone.
    renderMirror('/explore');
    expect(search()).toBe('');
  });

  it('writes the chosen range onto whatever route is showing', () => {
    renderMirror('/explore');
    act(() => setSharedTimeRange({ kind: 'relative', duration: '15m' }));
    expect(search()).toBe('?start=15m');
  });

  it('deletes `end` when the range goes relative — Perses reads start alone', () => {
    renderMirror('/explore?start=1754500000000&end=1754503600000');
    act(() => setSharedTimeRange({ kind: 'relative', duration: '1h' }));
    expect(search()).toBe('?start=1h');
  });

  it('preserves query params it does not own', () => {
    renderMirror('/alerts?status=firing');
    act(() => setSharedTimeRange({ kind: 'relative', duration: '6h' }));
    expect(search()).toContain('status=firing');
    expect(search()).toContain('start=6h');
  });

  it('settles instead of ping-ponging with the value it just adopted', () => {
    // Both directions are guarded on the ENCODED range, so a value that
    // round trips through either writer converges.
    renderMirror('/explore?start=6h');
    const before = search();
    act(() => setSharedTimeRange({ kind: 'relative', duration: '6h' }));
    expect(search()).toBe(before);
  });
});

describe('the range survives a route change', () => {
  function Jump(): ReactElement {
    const navigate = useNavigate();
    // Perses' own nav links carry no query string.
    useEffect(() => {
      const t = setTimeout((): void => navigate('/explore'), 0);
      return (): void => clearTimeout(t);
    }, [navigate]);
    return <span />;
  }

  it('carries a dashboard range into Explore', () => {
    jest.useFakeTimers();
    render(
      <MemoryRouter initialEntries={['/projects/my-project/dashboards/nodehealth?start=24h']}>
        <Mirror />
        <Routes>
          <Route path="/projects/*" element={<Jump />} />
          <Route path="/explore" element={<span data-testid="on-explore" />} />
        </Routes>
      </MemoryRouter>
    );
    expect(readSharedTimeRange()).toEqual({ kind: 'relative', duration: '24h' });
    act(() => {
      jest.runAllTimers();
    });
    expect(screen.getByTestId('on-explore')).toBeInTheDocument();
    // Still 24h, and re-published onto the new route's URL.
    expect(readSharedTimeRange()).toEqual({ kind: 'relative', duration: '24h' });
    expect(search()).toBe('?start=24h');
    jest.useRealTimers();
  });
});

describe('dashboard seeding is ordered, not raced', () => {
  function Dash(): ReactElement {
    const ready = useSeedDashboardTimeParams();
    const location = useLocation();
    return (
      <span data-testid="dash">
        {ready ? 'ready' : 'seeding'}:{location.search}
      </span>
    );
  }

  function renderDash(initial: string): void {
    render(
      <MemoryRouter initialEntries={[initial]}>
        <Dash />
      </MemoryRouter>
    );
  }

  it('is ready immediately on a cold session — an authored duration stands', () => {
    renderDash('/projects/my-project/dashboards/nodehealth');
    expect(screen.getByTestId('dash')).toHaveTextContent('ready:');
  });

  it('is ready immediately when the URL already carries a range', () => {
    setSharedTimeRange({ kind: 'relative', duration: '1h' });
    renderDash('/projects/my-project/dashboards/nodehealth?start=6h');
    expect(screen.getByTestId('dash')).toHaveTextContent('ready:?start=6h');
  });

  it('withholds the dashboard until the chosen range is in the URL', () => {
    // "Not ready" is the point: the caller must not render ViewDashboard
    // while this is false, or useInitialTimeRange captures the dashboard's
    // own default and the shared range looks ignored.
    setSharedTimeRange({ kind: 'absolute', startMs: 1_754_500_000_000, endMs: 1_754_503_600_000 });
    renderDash('/projects/my-project/dashboards/nodehealth');
    expect(screen.getByTestId('dash')).toHaveTextContent('ready:?start=1754500000000&end=1754503600000');
  });
});
