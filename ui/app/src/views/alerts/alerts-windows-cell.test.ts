// Copyright OBSESC Authors
//
// U23 — the Alerts "Windows" column read 0 on every row.
//
// It was not an off-by-one and not an unpopulated field: `0` is the literal
// truth on the wire. `SeriesAlertState.consecutive_windows` is documented
// "`0` after resolution" and `apply_flush` zeroes it on the Firing →
// Resolved edge (crates/alert/obsesc-alert/src/state.rs). The verification
// rig had 9 fired / 9 resolved and nothing still firing, so every visible
// row was a resolved one — and the column was, correctly, all zeroes.
//
// "Held for zero windows" is nonetheless a FALSE claim: the run length was
// discarded, not measured as zero. These tests pin the distinction.

import { consecutiveWindowsCell } from './AlertsView';

describe('consecutiveWindowsCell', () => {
  it('renders a live run as its number, with nothing to explain', () => {
    expect(consecutiveWindowsCell({ status: 'firing', consecutive_windows: 3 })).toEqual({ text: '3', why: null });
    expect(consecutiveWindowsCell({ status: 'pending', consecutive_windows: 1 })).toEqual({ text: '1', why: null });
  });

  it('never renders a resolved alert as 0', () => {
    const cell = consecutiveWindowsCell({ status: 'resolved', consecutive_windows: 0 });
    expect(cell.text).toBe('—');
    expect(cell.why).toMatch(/cleared when an alert resolves/);
  });

  it('says something DIFFERENT when a live alert reports no count', () => {
    // Same rendered glyph, different reason: a firing alert with no count is
    // a node that did not populate the field, which is not the same fact as
    // "the run ended". Collapsing the two would hide a real wire problem.
    const cell = consecutiveWindowsCell({ status: 'firing', consecutive_windows: 0 });
    expect(cell.text).toBe('—');
    expect(cell.why).toMatch(/reported no consecutive-window count/);
  });

  it('survives a drifted body that omits the field entirely', () => {
    const cell = consecutiveWindowsCell({
      status: 'firing',
      consecutive_windows: undefined as unknown as number,
    });
    expect(cell.text).toBe('—');
    expect(cell.why).not.toBeNull();
  });
});
