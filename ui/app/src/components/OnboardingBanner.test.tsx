// Copyright OBSESC Authors
//
// P4-1: "No ingest yet. Send your first event so the dashboards can light up."
// — rendered on every dashboard of a cluster holding 9.17 TB stored and
// 11.6 TB committed, during the paused query-focused walkthrough that a
// customer demo is.
//
// The mechanism was one predicate. `useOnboarded` asked
// `totalIngestBytesCumulative > 0`, which sums `obsesc_ingest_bytes_total` —
// the meter's own docs call it the VOLATILE observability counter and say it
// resets on restart. So the banner was really asking "has this process seen
// bytes since it booted", a question about recent traffic, and answering it
// for a question about whether data exists.
//
// These tests run the REAL /metrics text through the REAL parser, so they pin
// the whole chain (scrape → predicate → render) rather than a boolean someone
// could re-derive wrongly. Both ends are pinned: silent whenever the node can
// show that data landed, and still present on a node where nothing ever did —
// an empty state that never appears is not a fix.

import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { NodeStats, parsePrometheus } from '../views/cluster/use-node-stats';
import { OnboardingBanner } from './OnboardingBanner';

// `@perses-dev/components`'s barrel re-exports EChart, so importing it for one
// four-line hook drags echarts into jsdom and dies there. The ONE hook this
// tree needs is supplied here instead, with real localStorage semantics — the
// banner's dismissal must behave, since "dismissed" and "hidden because the
// node has data" are the two states these tests have to tell apart.
jest.mock('@perses-dev/components', () => ({
  useLocalStorage: <T,>(key: string, initial: T): [T, (v: T) => void] => {
    /* eslint-disable react-hooks/rules-of-hooks */
    const [value, setValue] = useState<T>(() => {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    });
    /* eslint-enable react-hooks/rules-of-hooks */
    return [
      value,
      (v: T): void => {
        window.localStorage.setItem(key, JSON.stringify(v));
        setValue(v);
      },
    ];
  },
}));

const useNodeStatsMock = jest.fn();
jest.mock('../views/cluster/use-node-stats', () => {
  const actual = jest.requireActual('../views/cluster/use-node-stats');
  return { ...actual, useNodeStats: (...args: unknown[]): unknown => useNodeStatsMock(...args) };
});

/**
 * The demo cluster's actual failure shape, on the wire: the RECEIVED counter
 * is present and zero (the node was restarted after the load), the durable
 * WAL committed counter is present and enormous, and nothing is arriving
 * because the cluster is paused for the walkthrough.
 */
const RESTARTED_NODE = [
  '# TYPE obsesc_ingest_bytes_total counter',
  'obsesc_ingest_bytes_total{source="es-bulk"} 0',
  'obsesc_ingest_bytes_total{source="otlp-http"} 0',
  '# TYPE obsesc_wal_committed_bytes_total counter',
  'obsesc_wal_committed_bytes_total{shard="0"} 5800000000000',
  'obsesc_wal_committed_bytes_total{shard="1"} 5800000000000',
  '# TYPE obsesc_wal_checkpoint_segment gauge',
  'obsesc_wal_checkpoint_segment{shard="0"} 88000',
  '',
].join('\n');

/** Committed absent from the scrape; only the checkpoint proves the data. */
const CHECKPOINT_ONLY = [
  'obsesc_ingest_bytes_total{source="es-bulk"} 0',
  'obsesc_wal_checkpoint_segment{shard="0"} 3',
  'obsesc_wal_checkpoint_offset{shard="0"} 4096',
  '',
].join('\n');

/** A genuinely fresh node: every meter present, every meter zero. */
const FRESH_NODE = [
  'obsesc_ingest_bytes_total{source="es-bulk"} 0',
  'obsesc_wal_committed_bytes_total{shard="0"} 0',
  'obsesc_wal_checkpoint_segment{shard="0"} 0',
  'obsesc_wal_checkpoint_offset{shard="0"} 0',
  '',
].join('\n');

function scraped(metrics: string): NodeStats {
  const stats = parsePrometheus(metrics);
  // No rate at all: two identical scrapes of a paused cluster.
  stats.committedMBps = 0;
  return stats;
}

function renderBanner(): void {
  render(
    <ThemeProvider theme={createTheme()}>
      <MemoryRouter
        initialEntries={['/dashboards/nodehealth']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <OnboardingBanner />
      </MemoryRouter>
    </ThemeProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useNodeStatsMock.mockReset();
});

describe('the onboarding banner keys on data, not on rate', () => {
  it('stays silent on a loaded cluster whose received counter reset', () => {
    useNodeStatsMock.mockReturnValue({ data: scraped(RESTARTED_NODE) });
    renderBanner();
    expect(screen.queryByText(/No ingest yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Send your first event/)).not.toBeInTheDocument();
  });

  it('stays silent when only the WAL checkpoint has moved', () => {
    useNodeStatsMock.mockReturnValue({ data: scraped(CHECKPOINT_ONLY) });
    renderBanner();
    expect(screen.queryByText(/No ingest yet/)).not.toBeInTheDocument();
  });

  it('still appears on a node where nothing has ever landed', () => {
    useNodeStatsMock.mockReturnValue({ data: scraped(FRESH_NODE) });
    renderBanner();
    expect(screen.getByText('No ingest yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open onboarding/ })).toBeInTheDocument();
  });

  it('appears while the node has not answered yet — absence of proof is not proof', () => {
    useNodeStatsMock.mockReturnValue({ data: undefined });
    renderBanner();
    expect(screen.getByText('No ingest yet.')).toBeInTheDocument();
  });
});

describe('hasEverIngested is derived from the durable meters', () => {
  it('is true when only the durable committed counter is non-zero', () => {
    const parsed = parsePrometheus(RESTARTED_NODE);
    // The exact pair that made the old predicate wrong.
    expect(parsed.totalIngestBytesCumulative).toBe(0);
    expect(parsed.committedBytesCumulative).toBe(11_600_000_000_000);
    expect(parsed.hasEverIngested).toBe(true);
  });

  it('is false on a genuinely fresh node', () => {
    expect(parsePrometheus(FRESH_NODE).hasEverIngested).toBe(false);
  });

  it('is true when only the volatile received counter is non-zero', () => {
    // First event of the very first onboarding: received has moved, the WAL
    // checkpoint has not been written yet. That is still ingest.
    expect(parsePrometheus('obsesc_ingest_bytes_total{source="es-bulk"} 412\n').hasEverIngested).toBe(true);
  });
});
