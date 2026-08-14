// Copyright OBSESC Authors
//
// P4-2: the needle box answered a failed search with the two lines
//
//     ✗ failed after 0.1s
//     TypeError: Failed to fetch
//
// The first line is a measurement and stays. The second names a JavaScript
// class. These tests pin the rule that replaced it: no raw exception text ever
// reaches the operator, server-composed text is never re-worded, and nothing
// is invented when we genuinely do not know what to advise.

import { describeOpError } from './op-error';

describe('a browser exception never reaches the operator', () => {
  it('turns "TypeError: Failed to fetch" into a fault and a next step', () => {
    const e = describeOpError('TypeError: Failed to fetch', 'needle search');
    expect(e.headline).toBe('Could not reach the node, so the needle search never ran.');
    expect(e.headline).not.toMatch(/TypeError/);
    expect(e.advice).toMatch(/\/obsesc-api/);
    // The four indistinguishable causes are named as four, not guessed at.
    expect(e.advice).toMatch(/proxy or load balancer/);
    expect(e.detail).toBeNull();
  });

  it('recognises the same fault under the other browsers names for it', () => {
    for (const raw of ['TypeError: Load failed', 'TypeError: NetworkError when attempting to fetch resource.']) {
      expect(describeOpError(raw, 'query').headline).toBe('Could not reach the node, so the query never ran.');
    }
  });

  it('strips the class name off anything else it does not recognise', () => {
    const e = describeOpError('RangeError: Maximum call stack size exceeded', 'grep');
    expect(e.headline).toBe('The grep failed before it could return a result.');
    // The verbatim text is KEPT — it is what gets pasted into an ops channel —
    // but as detail, never as the headline.
    expect(e.detail).toBe('Maximum call stack size exceeded');
  });

  it('says so plainly when nothing said why', () => {
    expect(describeOpError('', 'query').headline).toBe('The query failed, and nothing said why.');
  });
});

describe('HTTP failures are named, and the server keeps its own words', () => {
  it('renders a 400 body verbatim as the detail', () => {
    const e = describeOpError('400: range exceeds the retention horizon (90 days)', 'needle search');
    expect(e.headline).toBe('The node would not accept this needle search request.');
    expect(e.detail).toBe('range exceeds the retention horizon (90 days)');
  });

  it('distinguishes "not permitted" from "not there" from "not configured"', () => {
    expect(describeOpError('403: forbidden', 'query').headline).toMatch(/Not authorised/);
    expect(describeOpError('404: not found', 'needle search').headline).toMatch(/has no endpoint for needle search/);
    expect(describeOpError('503: raw tier / catalog not configured', 'needle search').headline).toMatch(
      /up but cannot answer/
    );
  });

  it('blames the node, not the operator, for a 5xx', () => {
    const e = describeOpError('500: needle probe failed: catalog load: timeout', 'needle search');
    expect(e.headline).toBe('The node failed while answering this needle search.');
    expect(e.detail).toBe('needle probe failed: catalog load: timeout');
  });

  it('does not invent advice for a status it has nothing to say about', () => {
    const e = describeOpError('418: teapot', 'query');
    expect(e.headline).toBe('The query was refused (HTTP 418).');
    expect(e.advice).toBeNull();
  });
});

describe('our own schema-drift throws pass through', () => {
  it('keeps the loud message exactly as written', () => {
    const msg = 'POST /v1/needle did not return a `candidates` array — this node is not one this UI knows.';
    const e = describeOpError(`Error: ${msg}`, 'needle search');
    expect(e.headline).toBe(msg);
    expect(e.detail).toBeNull();
  });
});
