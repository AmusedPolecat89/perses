// Copyright OBSESC Authors
//
// U6 — onboarding badged an HTTP 405 in success GREEN.
//
// The probe GETs `/v1/query`, which is POST-only, so 405 IS the healthy
// answer and the old `res.ok || res.status === 405 → color="success"` was
// correct underneath. It still read as a bug at a glance, because green is
// the colour the operator scans for and a 4xx wearing it is a contradiction.

import { CHECKS, probeVerdict } from './HealthCheckStep';

const queryCheck = CHECKS.find((c) => c.label === '/v1/query')!;
const healthCheck = CHECKS.find((c) => c.label === '/v1/health')!;

describe('probeVerdict', () => {
  it('greens a 2xx on a row that expects one', () => {
    expect(probeVerdict(200, healthCheck)).toEqual({ tone: 'success', label: 'HTTP 200' });
  });

  it('never greens a 4xx, even when the 4xx is the healthy answer', () => {
    const verdict = probeVerdict(405, queryCheck);
    expect(verdict.tone).not.toBe('success');
    expect(verdict.tone).toBe('info');
  });

  it('says on the chip WHY the 405 is fine', () => {
    expect(probeVerdict(405, queryCheck).label).toBe('HTTP 405 — expected — POST only');
  });

  it('warns when a row answers with anything but its healthy status', () => {
    expect(probeVerdict(500, queryCheck)).toEqual({ tone: 'warning', label: 'HTTP 500' });
    expect(probeVerdict(405, healthCheck)).toEqual({ tone: 'warning', label: 'HTTP 405' });
    // The pre-fix rule treated 405 as a pass on EVERY row; a /v1/health that
    // has started answering 405 is a real regression and must not be green.
  });

  it('declares a healthy status for every shipped row', () => {
    for (const c of CHECKS) {
      expect(typeof c.healthyStatus).toBe('number');
      // A row whose healthy answer is not 2xx must explain itself, or the
      // info chip degrades to a bare "expected" nobody can act on.
      if (c.healthyStatus < 200 || c.healthyStatus >= 300) expect(c.healthyNote).toBeTruthy();
    }
  });
});
