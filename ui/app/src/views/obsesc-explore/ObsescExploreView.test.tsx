// Copyright OBSESC Authors
//
// Regression coverage for the Explore defects these lanes fix.
//
// From the progress lane (both RED against the pre-lane implementation):
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
//
// From the cost-redenomination lane, where the failures were WIRE
// failures a type checker cannot see (the view parsed `any`-shaped JSON):
//
//   3. The scan gate moved 402 → 412. A status-code literal is invisible
//      to tsc, so the gate silently became an error alert.
//   4. `POST /v1/sql` stopped answering with a bare row array.
//   5. `cost_usd` left the default surface; every byte figure is now a raw
//      integer rendered in BINARY units, and every ceiling carries "up to".
//   6. `null` rowgroup counts mean UNKNOWN, never zero; `showback: null`
//      means no monetary field renders at all.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { resetSharedTimeRange, setSharedTimeRange } from '../../hooks/use-shared-time-range';
import ObsescExploreView, { applyRangeToSql } from './ObsescExploreView';

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

/** The JSON body a `/v1/sql` call was made with. */
function bodyOf(call: unknown[] | undefined): Record<string, unknown> {
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

// ─── scan-wire fixtures ────────────────────────────────────────────────
// Transcribed from the real serialization dump, values and all: 143797000000
// is 133.9 GiB, 575188000000 is 535.7 GiB, 12582912 is 12.0 MiB, and 1371.36 s
// is "~23 min". If the formatter drifts back to decimal units, these numbers
// are what catch it.

type Json = Record<string, unknown>;

function makeBound(over: Json = {}): Json {
  return {
    kind: 'scan_bounded',
    max_rows: 10,
    offset: 0,
    per_shard_max_rows: 10,
    early_exit: true,
    blocked_by: null,
    ...over,
  };
}

function makePreview(over: Json = {}): Json {
  return {
    scope: 'raw_tier',
    nodes: 3,
    files_planned: 5541,
    rowgroups_planned: 5541,
    rowgroups_total: 5920,
    bytes_on_disk_ceiling: 143797000000,
    bytes_decompressed_ceiling: 575188000000,
    decompression_ratio: 4.0,
    seconds_ceiling: 1371.3550567626953,
    bound: makeBound(),
    ingest_impact: {
      scan_slots: 2,
      scan_slots_total: 4,
      scan_slots_inflight: 0,
      competes_with_ingest: true,
      note: 'Holds 2 of 4 scan slots for up to ~23 min. Parquet decode competes with the write path for CPU.',
    },
    honesty: 'Ceiling, not a forecast. Scan is not metered — OBSESC charges once, on ingest.',
    showback: null,
    ...over,
  };
}

function makeConsumption(over: Json = {}): Json {
  return {
    scope: 'raw_tier',
    nodes: 3,
    files_planned: 5541,
    files_touched: 2,
    bytes_read: 12582912,
    rows_scanned: 131072,
    rows_returned: 10,
    elapsed_ms: 940,
    rowgroups_pruned_statistics: 18,
    rowgroups_pruned_bloom: 0,
    rows_pruned_pushdown: 118000,
    rows_pruned_page_index: 0,
    complete: true,
    note: 'bytes_read counts column-chunk range fetches only; Parquet footer and metadata reads are not included.',
    showback: null,
    ...over,
  };
}

/** `POST /v1/sql` 200 — the envelope that replaced the bare row array. */
function makeRunBody(rows: Json[] = [], over: Json = {}): Json {
  return { rows, estimate: makePreview(), consumption: makeConsumption(), ...over };
}

// ─── the needle wire ───────────────────────────────────────────────────
//
// `POST /v1/needle`. The box used to call `GET /v1/search_tokens`, which is
// structurally unbounded — it walks the summary tier from the root and fully
// decodes every .obsc file it finds regardless of the requested range, 363,012
// of them on one node of the 9 TB cluster — and therefore never returned at
// all. These fixtures are the shape of the endpoint that does.

/** One signature-covered candidate: the index flagged specific rowgroups. */
function makeCandidate(file: string, over: Json = {}): Json {
  return { file, size_bytes: 1000, indexed: true, total_rowgroups: 4, rowgroups: [0], ...over };
}

/** A file no signature covers — kept whole, and honestly labelled as such. */
function makeUncovered(file: string, over: Json = {}): Json {
  return { file, size_bytes: 600, indexed: false, total_rowgroups: 0, rowgroups: null, ...over };
}

function makeNeedleStats(over: Json = {}): Json {
  return {
    slabs_probed: 4,
    manifests_probed: 0,
    probe_bytes: 12_288,
    covered_files: 900,
    unindexed_files: 0,
    listing_failed: false,
    manifest_budget_exhausted: false,
    ...over,
  };
}

/** `POST /v1/needle` 200. */
function makeNeedleBody(candidates: Json[] = [], over: Json = {}): Json {
  return {
    token: 'abc',
    from_ns: 0,
    to_ns: 1,
    candidates,
    stats: makeNeedleStats(),
    scan_estimate: makePreview(),
    approximate: true,
    note: 'membership-only: candidates are a superset (signature FPR; unindexed files are whole-file candidates)…',
    ...over,
  };
}

/** A raw key in the hour partition the UI groups by. */
function key(day: string, hour: string, name = 'a', shard = 0): string {
  return `raw/shard-${shard}/${day.replaceAll('-', '/')}/${hour}/${name}.parquet`;
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  // The shared time range (U11) is a MODULE store by design — a view has to
  // be mountable without a provider or a Router — so it survives between
  // tests unless it is cleared.
  resetSharedTimeRange();
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
      if (String(url).endsWith('/v1/sql')) return Promise.resolve(jsonResponse(makeRunBody()));
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
        return Promise.resolve(jsonResponse(makeRunBody([{ service: 'svc-a', body: 'hello' }])));
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
      if (String(url).includes('/v1/needle')) {
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

    fast.resolve(jsonResponse(makeNeedleBody([makeCandidate(key('2026-08-09', '01'))])));
    await waitFor(() => expect(screen.getByText('2026-08-09')).toBeInTheDocument());

    slow.resolve(jsonResponse(makeNeedleBody([makeCandidate(key('2026-08-02', '05'))])));
    await settle();
    expect(screen.getByText('2026-08-09')).toBeInTheDocument();
    expect(screen.queryByText('2026-08-02')).not.toBeInTheDocument();
  });
});

describe('the needle box calls the endpoint that can answer', () => {
  it('POSTs /v1/needle and never touches /v1/search_tokens', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/needle')) return Promise.resolve(jsonResponse(makeNeedleBody()));
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'ORD-7741' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await waitFor(() => expect(screen.getByTestId('needle-summary')).toBeInTheDocument());

    // `GET /v1/search_tokens` is not merely slower: it walks the summary tier
    // from the root and decodes every .obsc file whatever range you asked
    // for, so it cannot answer at estate scale at all. One call, to the other
    // endpoint, by POST.
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes('/v1/search_tokens'))).toHaveLength(0);
    const needle = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v1/needle'));
    expect(needle).toHaveLength(1);
    expect((needle[0]![1] as RequestInit).method).toBe('POST');
    expect(bodyOf(needle[0])).toMatchObject({ token: 'ORD-7741' });
  });

  it('sends no `service` — the needle index is service-blind by construction', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/needle')) return Promise.resolve(jsonResponse(makeNeedleBody()));
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText(/^Service/), { target: { value: 'svc-a' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await waitFor(() => expect(screen.getByTestId('needle-summary')).toBeInTheDocument());
    const needle = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v1/needle'));
    // The service box drives the DRILL only. Sending it would advertise a
    // filter the endpoint does not have.
    expect(bodyOf(needle[0])).not.toHaveProperty('service');
  });
});

describe('P4-2 — a raw JS exception must never reach the operator', () => {
  it('renders a fault and a next step when the fetch itself rejects', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/needle')) return Promise.reject(new TypeError('Failed to fetch'));
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));

    const alert = await screen.findByTestId('needle-search-error');
    expect(alert).toHaveTextContent('Could not reach the node, so the needle search never ran.');
    expect(alert).toHaveTextContent(/\/obsesc-api/);
    // THE assertion. The box used to render, verbatim, "TypeError: Failed to
    // fetch" under "✗ failed after 0.1s".
    expect(document.body.textContent ?? '').not.toContain('TypeError');
    // The elapsed indicator is good and stays.
    expect(screen.getByTestId('asyncop-needle-search')).toHaveAttribute('data-phase', 'error');
    expect(screen.getByTestId('asyncop-needle-search')).toHaveTextContent(/✗ failed after/);
  });

  it('keeps the server 400 verbatim instead of paraphrasing it', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/needle')) {
        return Promise.resolve({
          ok: false,
          status: 400,
          text: async () => 'range exceeds the retention horizon (90 days)',
          json: async () => ({}),
        } as unknown as Response);
      }
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    const alert = await screen.findByTestId('needle-search-error');
    expect(alert).toHaveTextContent('range exceeds the retention horizon (90 days)');
  });
});

describe('needle drill — stale-response race and per-row busy state', () => {
  /** Two candidate hours, with a service named so the drill is reachable. */
  async function searchTwoHours(): Promise<HTMLElement[]> {
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText(/^Service/), { target: { value: 'svc-one' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await waitFor(() => expect(screen.getAllByTestId('needle-window-row')).toHaveLength(2));
    return screen.getAllByTitle('Grep this hour of svc-one for verbatim matches');
  }

  const TWO_HOURS = [makeUncovered(key('2026-08-07', '01')), makeUncovered(key('2026-08-07', '02'))];

  it('renders the NEWER drill even when the older one resolves last', async () => {
    const slow = deferred<Response>();
    const fast = deferred<Response>();
    let grep = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/needle')) return Promise.resolve(jsonResponse(makeNeedleBody(TWO_HOURS)));
      if (String(url).includes('/v1/raw_grep')) {
        grep += 1;
        return grep === 1 ? slow.promise : fast.promise;
      }
      return Promise.resolve(jsonResponse({}));
    });

    const rows = await searchTwoHours();
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
      if (String(url).includes('/v1/needle')) return Promise.resolve(jsonResponse(makeNeedleBody(TWO_HOURS)));
      if (String(url).includes('/v1/raw_grep')) return grep.promise;
      return Promise.resolve(jsonResponse({}));
    });

    const rows = await searchTwoHours();
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(rows[0]!).toHaveAttribute('aria-busy', 'true'));
    expect(rows[1]!).not.toHaveAttribute('aria-busy', 'true');

    grep.resolve(jsonResponse({ events: [], truncated: false, files_scanned: 4 }));
    await waitFor(() => expect(rows[0]!).toHaveAttribute('aria-busy', 'false'));
  });

  it('does not offer a grep it cannot run — no service, no request', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/needle')) return Promise.resolve(jsonResponse(makeNeedleBody(TWO_HOURS)));
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await waitFor(() => expect(screen.getAllByTestId('needle-window-row')).toHaveLength(2));

    // The raw grep matches `service` EXACTLY at the reader, and the needle
    // index does not record which service a file's rows belong to — that is
    // what makes an estate-wide sweep possible. So the affordance says what
    // is missing instead of firing a request that can only return nothing.
    expect(screen.getByTestId('needle-drill-hint')).toHaveTextContent(/Name a service above/);
    fireEvent.click(screen.getAllByTestId('needle-window-row')[0]!);
    await settle();
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v1/raw_grep'))).toHaveLength(0);
    expect(screen.queryByTestId('needle-drill-panel')).not.toBeInTheDocument();
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

// ───────────────────────────────────────────────────────────────────────
// Cost redenomination — the wire moved and none of it is type-visible.
// ───────────────────────────────────────────────────────────────────────

/** Mount, click Estimate, wait for the ceiling chips. */
async function estimateWith(preview: Json): Promise<void> {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/v1/sql/estimate')) return Promise.resolve(jsonResponse(preview));
    return Promise.resolve(jsonResponse({}));
  });
  renderExplore();
  fireEvent.click(screen.getByRole('button', { name: /^Estimate/ }));
  await waitFor(() => expect(screen.getByTestId('scan-ceiling')).toBeInTheDocument());
}

/** Mount, click Run, wait for the estimated-vs-actual line. */
async function runWith(body: Json): Promise<void> {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
    if (String(url).endsWith('/v1/sql')) return Promise.resolve(jsonResponse(body));
    return Promise.resolve(jsonResponse({}));
  });
  renderExplore();
  fireEvent.click(screen.getByRole('button', { name: /^Run/ }));
  await waitFor(() => expect(screen.getByTestId('scan-actuals')).toBeInTheDocument());
}

describe('the scan gate is 412, not 402', () => {
  const gate = {
    rejected: true,
    reason: 'max_scan_bytes',
    limit: 107374182400,
    observed: 143797000000,
    estimate: makePreview(),
    message:
      'Planned to read up to 133.9 GiB across 5541 file(s) (~23 min) — above your max_scan_bytes of 100.0 GiB. ' +
      'This query is row-limited to 10 rows and may early-exit far below the ceiling. ' +
      'Resubmit with confirm=true to run it.',
  };

  it('renders 412 as a confirmation, then resends with confirm:true', async () => {
    let posts = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      if (String(url).endsWith('/v1/sql')) {
        posts += 1;
        return Promise.resolve(posts === 1 ? jsonResponse(gate, 412) : jsonResponse(makeRunBody([{ a: 1 }])));
      }
      return Promise.resolve(jsonResponse({}));
    });

    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: /^Run/ }));
    await waitFor(() => expect(screen.getByTestId('scan-gate')).toBeInTheDocument());
    expect(screen.getByTestId('scan-gate')).toHaveTextContent(/above your max_scan_bytes of 100\.0 GiB/);

    // The FIRST Run names no ceiling and does not pre-confirm: a stock node
    // has no gate, a configured one gates with ITS OWN limits, and only then
    // is the operator asked. The pre-lane view sent `confirm: true` always,
    // which made the gate unreachable by design.
    expect(bodyOf(sqlRunCalls(fetchMock)[0])).toEqual({ sql: expect.any(String) });

    fireEvent.click(screen.getByRole('button', { name: /Confirm & run/ }));
    await waitFor(() => expect(sqlRunCalls(fetchMock)).toHaveLength(2));
    const second = bodyOf(sqlRunCalls(fetchMock)[1]);
    expect(second.confirm).toBe(true);
    // Acknowledging the node's limit is not the same as inventing a new one.
    expect(second).not.toHaveProperty('max_scan_bytes');
    expect(second).not.toHaveProperty('max_scan_seconds');
    expect(second).not.toHaveProperty('max_cost_usd');
    await waitFor(() => expect(screen.getByTestId('sql-results')).toBeInTheDocument());
  });

  it('carries no currency symbol into the gate confirmation', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      if (String(url).endsWith('/v1/sql')) return Promise.resolve(jsonResponse(gate, 412));
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: /^Run/ }));
    await waitFor(() => expect(screen.getByTestId('scan-gate')).toBeInTheDocument());
    // The button used to read "Confirm & run (~$23.01)".
    expect(screen.getByTestId('scan-gate').textContent ?? '').not.toContain('$');
    expect(screen.getByRole('button', { name: /Confirm & run/ })).toHaveTextContent('up to 133.9 GiB');
  });

  it('does NOT treat a 402 as the gate — a stale node surfaces loudly', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      if (String(url).endsWith('/v1/sql')) return Promise.resolve(jsonResponse(gate, 402));
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: /^Run/ }));
    await waitFor(() => expect(screen.getByTestId('asyncop-sql-run')).toHaveAttribute('data-phase', 'error'));
    expect(screen.queryByTestId('scan-gate')).not.toBeInTheDocument();
  });
});

describe('the /v1/sql envelope replaced the bare row array', () => {
  it('fails loudly — not silently empty — when a node answers with an array', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      if (String(url).endsWith('/v1/sql')) return Promise.resolve(jsonResponse([{ service: 'svc-a' }]));
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: /^Run/ }));
    await waitFor(() => expect(screen.getByTestId('asyncop-sql-run')).toHaveAttribute('data-phase', 'error'));
    // An empty table would be indistinguishable from "your query matched
    // nothing" — the one failure mode this surface cannot afford.
    expect(screen.queryByTestId('sql-results')).not.toBeInTheDocument();
    expect(screen.getByText(/\{rows, estimate, consumption\}/)).toBeInTheDocument();
  });

  it('renders rows out of envelope.rows', async () => {
    await runWith(makeRunBody([{ service: 'svc-a', body: 'hello' }]));
    expect(screen.getByTestId('sql-results')).toHaveTextContent('svc-a');
  });
});

describe('estimated up to X · actually read Y', () => {
  it('stands the ceiling next to what the run actually read', async () => {
    await runWith(makeRunBody([{ a: 1 }]));
    // The U2/U3 payoff: 133.9 GiB of ceiling, 12.0 MiB actually read.
    expect(screen.getByTestId('scan-actuals')).toHaveTextContent(
      /estimated up to 133\.9 GiB · actually read 12\.0 MiB across 2 of 5.541 files/
    );
  });

  it('says "rows scanned", never "rows matched"', async () => {
    await runWith(makeRunBody([{ a: 1 }]));
    expect(screen.getByTestId('scan-actuals-rows')).toHaveTextContent(/rows scanned/);
    expect(document.body.textContent ?? '').not.toContain('rows matched');
  });

  it('renders consumption.note non-dismissably when complete is false', async () => {
    await runWith(makeRunBody([{ a: 1 }], { consumption: makeConsumption({ complete: false }) }));
    const alert = screen.getByTestId('scan-incomplete');
    expect(alert).toHaveTextContent(/FLOOR/);
    expect(alert).toHaveTextContent(/column-chunk range fetches only/);
    // Non-dismissable: MUI renders a close button only when onClose is given.
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ceilings are labelled, and bounds are chips', () => {
  it('prefixes every ceiling with "up to" and uses binary units', async () => {
    await estimateWith(makePreview());
    const chips = screen.getByTestId('scan-ceiling');
    expect(chips).toHaveTextContent('up to 133.9 GiB on disk');
    expect(chips).toHaveTextContent('up to 535.7 GiB decompressed');
    expect(chips).toHaveTextContent('up to ~23 min');
    // The pre-lane view divided by 1024³ and wrote "GB".
    expect(chips.textContent ?? '').not.toMatch(/\d\s?GB\b/);
  });

  it('scan_bounded → row-limited, early exit may read far less', async () => {
    await estimateWith(makePreview());
    expect(screen.getByTestId('scan-bound-chip')).toHaveTextContent('row-limited to 10 — early exit may read far less');
  });

  it('result_bounded → names the pipeline breaker forcing the full scan', async () => {
    await estimateWith(
      makePreview({
        bound: makeBound({ kind: 'result_bounded', early_exit: false, per_shard_max_rows: null, blocked_by: 'sort' }),
      })
    );
    expect(screen.getByTestId('scan-bound-chip')).toHaveTextContent('returns 10 rows, but sort forces a full scan');
  });

  it('unbounded → no bound chip at all', async () => {
    await estimateWith(
      makePreview({
        bound: makeBound({ kind: 'unbounded', max_rows: null, per_shard_max_rows: null, early_exit: false }),
      })
    );
    expect(screen.queryByTestId('scan-bound-chip')).not.toBeInTheDocument();
  });

  it('surfaces the ingest-impact note and the honesty note', async () => {
    await estimateWith(makePreview());
    expect(screen.getByTestId('scan-ingest-impact')).toHaveTextContent(/Holds 2 of 4 scan slots/);
    expect(screen.getByTestId('scan-honesty')).toHaveTextContent(/OBSESC charges once, on ingest/);
  });
});

describe('null rowgroup counts mean UNKNOWN, never zero', () => {
  it('chips the skipped rowgroups when planned < total', async () => {
    await estimateWith(makePreview());
    expect(screen.getByText(/379 of 5.920 rowgroups signature-skipped/)).toBeInTheDocument();
  });

  it('renders no chip when either count is null', async () => {
    await estimateWith(makePreview({ rowgroups_planned: null, rowgroups_total: null }));
    expect(screen.queryByText(/rowgroups signature-skipped/)).not.toBeInTheDocument();
  });

  it('renders no chip when nothing was skipped', async () => {
    await estimateWith(makePreview({ rowgroups_planned: 5920, rowgroups_total: 5920 }));
    expect(screen.queryByText(/rowgroups signature-skipped/)).not.toBeInTheDocument();
  });
});

describe('showback is absent by default', () => {
  it('renders no monetary field anywhere when showback is null', async () => {
    await estimateWith(makePreview());
    expect(screen.queryByTestId('scan-showback')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('$');
    expect(document.body.textContent ?? '').not.toContain('USD');
  });

  it('renders the amount together with its label when configured', async () => {
    await estimateWith(
      makePreview({
        showback: {
          amount: 21.427422761917114,
          currency: 'USD',
          rate_per_gib_scanned: 0.04,
          basis: 'bytes_decompressed_ceiling',
          label: 'internal showback — OBSESC does not charge for queries',
        },
      })
    );
    const chip = screen.getByTestId('scan-showback');
    // amount and label are ONE unit — the number alone would read as a price.
    expect(chip).toHaveTextContent('21.43 USD');
    expect(chip).toHaveTextContent('internal showback — OBSESC does not charge for queries');
  });
});

// ───────────────────────────────────────────────────────────────────────
// The app-view sweep — U8 (ranked needle results), U9 (inline drill),
// U10 (no hand-editable epoch literals) and U11 (one time model).
// ───────────────────────────────────────────────────────────────────────

const NS_PER_MS = 1e6;

/** Mount, probe for a token, and wait for the ranked result to land. */
async function searchWith(candidates: Json[], extra: Json = {}, service = ''): Promise<void> {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/v1/needle')) {
      return Promise.resolve(jsonResponse(makeNeedleBody(candidates, extra)));
    }
    if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
    return Promise.resolve(jsonResponse({}));
  });
  renderExplore();
  fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'abc' } });
  if (service !== '') fireEvent.change(screen.getByLabelText(/^Service/), { target: { value: service } });
  fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
  await waitFor(() => expect(screen.getByTestId('needle-summary')).toBeInTheDocument());
}

/** The from_ns/to_ns the `POST /v1/needle` body carried. */
function searchWindow(mock: jest.Mock): { from: number; to: number } {
  const call = mock.mock.calls.find((c) => String(c[0]).includes('/v1/needle'));
  const body = bodyOf(call);
  return { from: Number(body.from_ns), to: Number(body.to_ns) };
}

/** MUI puts `aria-label` on the FormControl root, so reach for the textarea. */
function sqlText(): string {
  return (document.querySelector('textarea') as HTMLTextAreaElement).value;
}

/** Both epoch-ns bounds out of the seeded `timestamp_ns` predicate. */
function sqlBounds(): number[] {
  return [...sqlText().matchAll(/timestamp_ns\s*(?:>=|<)\s*(\d+)/g)].map((m) => Number(m[1]));
}

describe('U10 — the time control owns the epoch-ns literals', () => {
  it('rewrites the lower and upper bound, and only those', () => {
    // 1_000 rows and a 3-digit port are not time bounds and must survive.
    const sql =
      'SELECT * FROM raw_events WHERE timestamp_ns >= 1785824670563000000 AND timestamp_ns < 1785828270563000000 AND port = 8080 LIMIT 1000';
    const out = applyRangeToSql(sql, 111_000_000_000_000_000, 222_000_000_000_000_000);
    expect(out.rewrote).toBe(2);
    expect(out.sql).toContain('timestamp_ns >= 111000000000000000');
    expect(out.sql).toContain('timestamp_ns < 222000000000000000');
    expect(out.sql).toContain('port = 8080');
    expect(out.sql).toContain('LIMIT 1000');
  });

  it('reads the operator, so a reversed predicate is not written backwards', () => {
    const out = applyRangeToSql(
      'WHERE timestamp_ns <= 1785828270563000000 AND timestamp_ns > 1785824670563000000',
      111_000_000_000_000_000,
      222_000_000_000_000_000
    );
    expect(out.sql).toContain('timestamp_ns <= 222000000000000000');
    expect(out.sql).toContain('timestamp_ns > 111000000000000000');
  });

  it("rewrites a virtual column's window without touching its quoted template_key", () => {
    // A TemplateKey is a u64 in the SAME digit class as an epoch-ns literal
    // (19–20 digits). Only the trailing `, <ns>, <ns>)` pair may move.
    const out = applyRangeToSql(
      "SELECT * FROM template_events('svc-000', '18446744073709551615', 1785824670563000000, 1785828270563000000)",
      111_000_000_000_000_000,
      222_000_000_000_000_000
    );
    expect(out.rewrote).toBe(2);
    expect(out.sql).toContain("'18446744073709551615'");
    expect(out.sql).toContain('111000000000000000, 222000000000000000)');
  });

  it('reports zero rewrites rather than pretending, when there is no bound to own', () => {
    const out = applyRangeToSql('SELECT 1', 1, 2);
    expect(out.rewrote).toBe(0);
    expect(out.sql).toBe('SELECT 1');
  });

  it('renders the seeded window in words beside the literals', () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderExplore();
    // U10's complaint in one line: `timestamp_ns >= 1785824670563000000` is
    // not checkable by eye, so the same window is stated in UTC next to it.
    expect(screen.getByTestId('sql-window')).toHaveTextContent(/Last hour/);
    expect(screen.getByTestId('sql-window')).toHaveTextContent(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} → \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/
    );
  });
});

describe('U11 — one range, four surfaces', () => {
  it('seeds the SQL bounds from the shared range', () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderExplore();
    const [from, to] = sqlBounds();
    expect(to! - from!).toBeCloseTo(3600e9, -9); // the 1h default
  });

  it('rewrites the SQL bounds when the range moves — no hand editing', () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderExplore();
    act(() => setSharedTimeRange({ kind: 'relative', duration: '24h' }));
    const [from, to] = sqlBounds();
    expect(to! - from!).toBeCloseTo(24 * 3600e9, -9);
    expect(screen.getByTestId('sql-window')).toHaveTextContent(/Last 24 hours/);
    expect(screen.getByTestId('sql-window')).toHaveTextContent(/rewrote 2 bounds/);
  });

  it('writes an ABSOLUTE range straight into the query', () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderExplore();
    act(() => setSharedTimeRange({ kind: 'absolute', startMs: 1_754_500_000_000, endMs: 1_754_503_600_000 }));
    expect(sqlBounds()).toEqual([1_754_500_000_000 * NS_PER_MS, 1_754_503_600_000 * NS_PER_MS]);
  });

  it('searches the needle over the SAME range — the private Range dropdown is gone', async () => {
    // The needle used to carry its own `Range` select seeded at 1h, which is
    // half of what made moving an investigation between surfaces manual.
    setSharedTimeRange({ kind: 'absolute', startMs: 1_754_500_000_000, endMs: 1_754_503_600_000 });
    await searchWith([makeCandidate(key('2026-08-07', '01'))]);
    expect(searchWindow(fetchMock)).toEqual({
      from: 1_754_500_000_000 * NS_PER_MS,
      to: 1_754_503_600_000 * NS_PER_MS,
    });
    expect(screen.queryByLabelText('Range')).not.toBeInTheDocument();
  });

  it('renders exactly ONE time control on the page', () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderExplore();
    expect(screen.getAllByTestId('time-range-control')).toHaveLength(1);
  });
});

describe('U8 — the needle result is ranked, not a wall', () => {
  /**
   * The finding's shape, in miniature: a spread of uncovered files the index
   * could not rule out, and one day where the signatures actually flagged
   * something. The old wire's version of this was 4,056 identical rows.
   */
  function haystack(): Json[] {
    const out: Json[] = [];
    for (let i = 0; i < 12; i++) {
      out.push(makeUncovered(key('2026-08-0' + ((i % 4) + 1), String(i % 24).padStart(2, '0'), `f${i}`)));
    }
    out.push(makeCandidate(key('2026-08-09', '11', 'needle')));
    return out;
  }

  it('puts the signature-flagged day first and says why', async () => {
    await searchWith(haystack());
    expect(screen.getByTestId('needle-start-here')).toHaveTextContent(/Start with 2026-08-09/);
    const headers = screen.getAllByTestId('needle-group-header');
    expect(headers[0]).toHaveTextContent('2026-08-09');
    expect(headers[0]).toHaveTextContent('signature-flagged');
  });

  it('counts every verdict in the headline — nothing is filtered away', async () => {
    await searchWith(haystack());
    expect(screen.getByTestId('needle-summary')).toHaveTextContent('13 candidate files across 5 days');
    expect(screen.getByText('12 not covered (whole file kept)')).toBeInTheDocument();
    expect(screen.getByText('1 signature-flagged')).toBeInTheDocument();
  });

  it('merges every shard’s files for one hour into one row', async () => {
    // Three shards' candidates for 14:00 are ONE fact about 14:00, and the
    // drill greps that hour once. This is what keeps a 90-day sweep readable.
    await searchWith([
      makeCandidate(key('2026-08-07', '14', 'a', 0)),
      makeCandidate(key('2026-08-07', '14', 'b', 1)),
      makeCandidate(key('2026-08-07', '14', 'c', 2)),
    ]);
    const rows = screen.getAllByTestId('needle-window-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('14:00 → 15:00 UTC');
    expect(rows[0]).toHaveTextContent('3 files');
  });

  it('states the proven absences, which is the half that matters', async () => {
    // 900 files in range carry signatures; one of them is a candidate. The
    // other 899 are EXACT absences, and that is the claim no scan-based
    // search can make.
    await searchWith([makeCandidate(key('2026-08-07', '14'))]);
    expect(screen.getByTestId('needle-summary')).toHaveTextContent('899 files proven token-free');
    expect(screen.getByTestId('needle-probe-notes')).toHaveTextContent(/PROVABLY do not contain the token/);
    expect(screen.getByTestId('needle-probe-notes')).toHaveTextContent(/not hidden, they are excluded/);
  });

  it('reports what the probe itself cost, because that is the point', async () => {
    await searchWith([makeCandidate(key('2026-08-07', '14'))]);
    expect(screen.getByTestId('needle-probe-notes')).toHaveTextContent(/Probe read 12 KiB/);
    expect(screen.getByTestId('needle-probe-notes')).toHaveTextContent(/bounded by the index, not by the estate/);
  });

  it('renders the node’s honesty note verbatim rather than re-wording it', async () => {
    await searchWith([makeCandidate(key('2026-08-07', '14'))]);
    expect(screen.getByTestId('needle-honesty')).toHaveTextContent(/membership-only/);
  });

  it('stands the survivor-scan ceiling next to the bounded probe', async () => {
    // The probe is bounded; scanning what survived is NOT, and the node hands
    // back the ceiling for exactly that follow-up.
    await searchWith([makeCandidate(key('2026-08-07', '14'))]);
    expect(screen.getByTestId('scan-ceiling')).toHaveTextContent('up to 133.9 GiB on disk');
  });

  it('refuses to dress an all-uncovered result up as a ranking', async () => {
    await searchWith([makeUncovered(key('2026-08-07', '14'))]);
    expect(screen.getByTestId('needle-start-here')).toHaveTextContent(/Nothing here is signature-covered/);
    expect(screen.getByTestId('needle-start-here')).toHaveTextContent(/could not be ruled out/);
  });

  it('admits when the node returned no probe stats at all', async () => {
    await searchWith([makeUncovered(key('2026-08-07', '14'))], { stats: null });
    expect(screen.getByTestId('needle-probe-notes')).toHaveTextContent(/returned no probe stats/);
  });

  it('surfaces a degraded probe instead of quietly ranking on it', async () => {
    await searchWith([makeUncovered(key('2026-08-07', '14'))], {
      stats: makeNeedleStats({ listing_failed: true, manifest_budget_exhausted: true, unindexed_files: 3 }),
    });
    const notes = screen.getByTestId('needle-probe-notes');
    expect(notes).toHaveTextContent(/A store listing failed/);
    expect(notes).toHaveTextContent(/hit its byte budget/);
    expect(notes).toHaveTextContent(/3 raw files in range are not signature-covered/);
  });

  it('says "nothing survived" as the definite answer it is', async () => {
    await searchWith([]);
    expect(screen.getByTestId('needle-empty')).toHaveTextContent(/No candidate anywhere in range/);
    expect(screen.getByTestId('needle-empty')).toHaveTextContent(/definite "not here", not a maybe/);
  });

  it('fails loudly when a node answers without a candidate list', async () => {
    // An empty list is the BEST answer this product can give ("the index
    // proved the token is nowhere in range"), so a MISSING list must never be
    // able to impersonate one.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/needle')) return Promise.resolve(jsonResponse({ token: 'abc' }));
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await waitFor(() => expect(screen.getByTestId('asyncop-needle-search')).toHaveAttribute('data-phase', 'error'));
    expect(screen.queryByTestId('needle-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('needle-search-error')).toHaveTextContent(/did not return a `candidates` array/);
  });

  it('shows the tokenizer-normalized token the node actually probed', async () => {
    // `ORD-7741.` is indexed as `ORD-7741`. The operator must be told which
    // question was answered, and the drill must grep for THAT.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/needle')) {
        return Promise.resolve(
          jsonResponse(makeNeedleBody([makeCandidate(key('2026-08-07', '14'))], { token: 'ORD-7741' }))
        );
      }
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'ORD-7741.' } });
    fireEvent.change(screen.getByLabelText(/^Service/), { target: { value: 'svc-a' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await waitFor(() => expect(screen.getByTestId('needle-summary')).toBeInTheDocument());
    expect(screen.getByText(/probed as/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId('needle-window-row')[0]!);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/raw_grep'))).toBe(true));
    const grep = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v1/raw_grep'));
    expect(bodyOf(grep[0])).toMatchObject({ token: 'ORD-7741' });
  });

  it('refuses a phrase before spending a round trip on it', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'two words' } });
    expect(screen.getByTestId('needle-search-btn')).toBeDisabled();
    expect(screen.getByTestId('needle-phrase-hint')).toHaveTextContent(/a needle is one token/);
  });
});

describe('U9 — the drill answer renders under the row that asked', () => {
  it('renders the result immediately after the clicked row, not after the list', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/v1/needle')) {
        return Promise.resolve(
          jsonResponse(
            makeNeedleBody([
              makeUncovered(key('2026-08-07', '01')),
              makeUncovered(key('2026-08-07', '02')),
              makeUncovered(key('2026-08-07', '03')),
            ])
          )
        );
      }
      if (String(url).includes('/v1/raw_grep')) {
        return Promise.resolve(
          jsonResponse({
            events: [
              {
                timestamp_ns: 3600e9,
                source: 'otlp',
                service: 'svc-b',
                body_utf8: 'THE-ANSWER',
                attributes: {},
              },
            ],
            truncated: false,
            files_scanned: 1,
          })
        );
      }
      if (String(url).includes('/v1/sql/estimate')) return new Promise<Response>(() => {});
      return Promise.resolve(jsonResponse({}));
    });
    renderExplore();
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText(/^Service/), { target: { value: 'svc-b' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await waitFor(() => expect(screen.getAllByTestId('needle-window-row')).toHaveLength(3));

    fireEvent.click(screen.getAllByTestId('needle-window-row')[1]!);
    await waitFor(() => expect(screen.getByTestId('needle-drill-panel')).toHaveTextContent('THE-ANSWER'));

    // THE assertion: the panel is the clicked row's immediate sibling. It
    // used to live after the whole candidate list, so clicking row 11 of 50
    // put the answer below row 50 — reachable only by pressing End.
    const rows = screen.getAllByTestId('needle-window-row');
    expect(rows[1]!.nextElementSibling).toContainElement(screen.getByTestId('needle-drill-panel'));
    expect(rows[2]!.nextElementSibling).toBeNull();
  });

  it('greps the whole hour in ONE request, clamped to the probed range', async () => {
    // 2026-08-07 02:00 UTC, and the shared range is the last hour, so the
    // clamp is what keeps the grep inside the window the answer describes.
    const hourStart = Date.UTC(2026, 7, 7, 2);
    setSharedTimeRange({ kind: 'absolute', startMs: hourStart, endMs: hourStart + 1_800_000 });
    await searchWith(
      [makeUncovered(key('2026-08-07', '02', 'a', 0)), makeUncovered(key('2026-08-07', '02', 'b', 1))],
      {},
      'svc'
    );
    fireEvent.click(screen.getAllByTestId('needle-window-row')[0]!);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/raw_grep'))).toBe(true));
    const grep = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v1/raw_grep'));
    expect(grep).toHaveLength(1);
    expect(bodyOf(grep[0])).toMatchObject({
      service: 'svc',
      from_ns: hourStart * NS_PER_MS,
      // The hour ends at 03:00 but the probed range ended at 02:30: a click
      // must never grep outside the range the candidate list was computed for.
      to_ns: (hourStart + 1_800_000) * NS_PER_MS,
    });
  });
});
