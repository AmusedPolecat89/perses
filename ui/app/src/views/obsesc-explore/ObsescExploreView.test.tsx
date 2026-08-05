// Copyright OBSESC Authors
//
// Regression coverage for the two Explore defects this lane fixes. Both
// are RED against the pre-lane implementation:
//
//   1. U5 — the swallowed Run click. `ObsescExploreView` declared ONE
//      `busy` token for two independent operations and both buttons read
//      `disabled={busy !== null}`, so clicking Estimate disabled Run. The
//      next Run click hit a native disabled button: no handler, no
//      request, no error, no acknowledgement — while a shared spinner
//      sourced from the ESTIMATE sat on screen.
//   2. The stale-response race — neither the needle search nor the drill
//      had a generation guard, so two in-flight requests resolved in
//      ARRIVAL order and a slower OLDER answer overwrote a newer one.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import ObsescExploreView from './ObsescExploreView';

// jsdom here predates AbortSignal.timeout, which the view's apiFetch uses.
beforeAll(() => {
  const AS = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AS.timeout !== 'function') {
    AS.timeout = (ms: number): AbortSignal => {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), ms);
      return ctl.signal;
    };
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderExplore(): void {
  render(
    <ThemeProvider theme={createTheme()}>
      <ObsescExploreView />
    </ThemeProvider>
  );
}

/** Settle a resolved fetch through React: flush microtasks inside act(). */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Calls to POST /v1/sql — NOT /v1/sql/estimate, which is a different path. */
function sqlRunCalls(mock: jest.Mock): unknown[][] {
  return mock.mock.calls.filter((c) => String(c[0]).endsWith('/v1/sql'));
}

function estimateCalls(mock: jest.Mock): unknown[][] {
  return mock.mock.calls.filter((c) => String(c[0]).includes('/v1/sql/estimate'));
}

function makeWindow(service: string, startNs: number): Record<string, unknown> {
  return {
    service,
    window_start_ns: startNs,
    window_end_ns: startNs + 300e9,
    windows_merged: 1,
    event_count: 42,
    bloom_match: true,
    saturated: false,
  };
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('U5 — an in-flight Estimate must not swallow a Run click', () => {
  it('issues POST /v1/sql while the estimate is still in flight', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/sql/estimate')) {
        // The estimate is index-only but takes seconds at 1 TB. It never
        // resolves here: the whole point is that Run must still work.
        return new Promise<Response>(() => {});
      }
      if (String(url).endsWith('/v1/sql')) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    });

    renderExplore();
    const estimateBtn = screen.getByRole('button', { name: /^Estimate/ });
    const runBtn = screen.getByRole('button', { name: /^Run/ });

    fireEvent.click(estimateBtn);
    await waitFor(() => expect(estimateCalls(fetchMock)).toHaveLength(1));

    fireEvent.click(runBtn);
    // THE assertion. Before this lane the click hit a native disabled
    // button: no handler ran, so no request ever left the browser — which
    // is exactly what the U5 report described (no /v1/sql in the network
    // log, node 100% idle, and a spinner sourced from the estimate).
    await waitFor(() => expect(sqlRunCalls(fetchMock)).toHaveLength(1));
  });

  it('leaves Run enabled, and marks Estimate busy, while the estimate runs', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}));
    });

    renderExplore();
    const estimateBtn = screen.getByRole('button', { name: /^Estimate/ });
    const runBtn = screen.getByRole('button', { name: /^Run/ });

    fireEvent.click(estimateBtn);
    // The mechanism pin: a control may reflect its OWN state, and may never
    // be disabled by another operation's state.
    await waitFor(() => expect(estimateBtn).toHaveAttribute('aria-busy', 'true'));
    expect(runBtn).not.toBeDisabled();
    expect(estimateBtn).not.toBeDisabled();
  });

  it('leaves the previous results table in place when Estimate is clicked', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      if (String(url).endsWith('/v1/sql')) {
        return Promise.resolve(jsonResponse([{ service: 'svc-a', body: 'hello' }]));
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: /^Run/ }));
    await waitFor(() => expect(screen.getByTestId('sql-results')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Estimate/ }));
    // Estimate used to call reset(), blanking the results table with no
    // explanation.
    expect(screen.getByTestId('sql-results')).toBeInTheDocument();
  });
});

describe('needle search — stale-response race', () => {
  it('renders the NEWER search even when the older one resolves last', async () => {
    const slow = deferred<Response>();
    const fast = deferred<Response>();
    let search = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/search_tokens')) {
        search += 1;
        return search === 1 ? slow.promise : fast.promise;
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderExplore();
    const tokenInput = screen.getByLabelText(/^Token/);
    const searchBtn = screen.getByRole('button', { name: /^Search/ });

    fireEvent.change(tokenInput, { target: { value: 'abc' } });
    fireEvent.click(searchBtn);
    // Refine the token and search again — the control must still accept it.
    fireEvent.change(tokenInput, { target: { value: 'abcdef' } });
    fireEvent.click(searchBtn);

    fast.resolve(jsonResponse({ windows: [makeWindow('svc-newer', 2_000_000_000_000_000)], scanned_files: 7 }));
    await waitFor(() => expect(screen.getByText('svc-newer')).toBeInTheDocument());

    slow.resolve(jsonResponse({ windows: [makeWindow('svc-older', 1_000_000_000_000_000)], scanned_files: 3 }));
    await settle();
    expect(screen.getByText('svc-newer')).toBeInTheDocument();
    expect(screen.queryByText('svc-older')).not.toBeInTheDocument();
  });
});

describe('needle drill — stale-response race and per-row busy state', () => {
  async function searchTwoWindows(): Promise<HTMLElement[]> {
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await waitFor(() => expect(screen.getByText('svc-one')).toBeInTheDocument());
    return screen.getAllByTitle('Grep this window for verbatim matches');
  }

  it('renders the NEWER drill even when the older one resolves last', async () => {
    const slow = deferred<Response>();
    const fast = deferred<Response>();
    let grep = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/search_tokens')) {
        return Promise.resolve(
          jsonResponse({
            windows: [makeWindow('svc-one', 1_000_000_000_000_000), makeWindow('svc-two', 2_000_000_000_000_000)],
            scanned_files: 9,
          })
        );
      }
      if (String(url).includes('/v1/raw_grep')) {
        grep += 1;
        return grep === 1 ? slow.promise : fast.promise;
      }
      return Promise.resolve(jsonResponse({}));
    });

    const rows = await searchTwoWindows();
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[1]!);

    fast.resolve(
      jsonResponse({
        events: [
          {
            timestamp_ns: 2_000_000_000_000_000,
            source: 'otlp',
            service: 'svc-two',
            body_utf8: 'NEWER-DRILL-BODY',
            attributes: {},
          },
        ],
        truncated: false,
        files_scanned: 2,
      })
    );
    await waitFor(() => expect(screen.getByText(/NEWER-DRILL-BODY/)).toBeInTheDocument());

    slow.resolve(
      jsonResponse({
        events: [
          {
            timestamp_ns: 1_000_000_000_000_000,
            source: 'otlp',
            service: 'svc-one',
            body_utf8: 'OLDER-DRILL-BODY',
            attributes: {},
          },
        ],
        truncated: false,
        files_scanned: 1,
      })
    );
    await settle();
    expect(screen.getByText(/NEWER-DRILL-BODY/)).toBeInTheDocument();
    expect(screen.queryByText(/OLDER-DRILL-BODY/)).not.toBeInTheDocument();
  });

  it('marks the clicked row busy while its grep runs and clears it after', async () => {
    const grep = deferred<Response>();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/search_tokens')) {
        return Promise.resolve(
          jsonResponse({
            windows: [makeWindow('svc-one', 1_000_000_000_000_000), makeWindow('svc-two', 2_000_000_000_000_000)],
            scanned_files: 9,
          })
        );
      }
      if (String(url).includes('/v1/raw_grep')) return grep.promise;
      return Promise.resolve(jsonResponse({}));
    });

    const rows = await searchTwoWindows();
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(rows[0]!).toHaveAttribute('aria-busy', 'true'));
    expect(rows[1]!).not.toHaveAttribute('aria-busy', 'true');

    grep.resolve(jsonResponse({ events: [], truncated: false, files_scanned: 4 }));
    await waitFor(() => expect(rows[0]!).toHaveAttribute('aria-busy', 'false'));
  });
});

describe('the U5 class, structurally', () => {
  it('renders no control that is both aria-busy and disabled', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}));
    });

    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: /^Estimate/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Estimating/ })).toHaveAttribute('aria-busy', 'true')
    );
    expect(document.querySelectorAll('button[aria-busy="true"][disabled]')).toHaveLength(0);
  });
});
