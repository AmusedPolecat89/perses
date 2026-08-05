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
