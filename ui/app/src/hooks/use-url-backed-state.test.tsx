// Copyright OBSESC Authors
//
// B3.5 — the permalink contract: the URL restores the input, typing updates
// the URL (debounced, replace-only), and '' cleans its param away.

import { ReactElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useUrlBackedState } from './use-url-backed-state';

jest.useFakeTimers();

function Probe({ fallback }: { fallback: string }): ReactElement {
  const [value, setValue] = useUrlBackedState('needle', fallback);
  const location = useLocation();
  return (
    <>
      <input aria-label="needle" value={value} onChange={(e) => setValue(e.target.value)} />
      <span data-testid="search">{location.search}</span>
    </>
  );
}

function renderProbe(initial: string, fallback = ''): void {
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Probe fallback={fallback} />
    </MemoryRouter>
  );
}

it('restores the value from the URL at mount', () => {
  renderProbe('/explore?needle=TOK-99', 'fallback-ignored');
  expect(screen.getByLabelText('needle')).toHaveValue('TOK-99');
});

it('falls back when the URL carries nothing', () => {
  renderProbe('/explore', 'seed');
  expect(screen.getByLabelText('needle')).toHaveValue('seed');
});

it('writes the param after the debounce, preserving other params', () => {
  renderProbe('/explore?start=6h');
  fireEvent.change(screen.getByLabelText('needle'), { target: { value: 'evil-ioc' } });
  // Not yet — the debounce holds keystrokes back.
  expect(screen.getByTestId('search').textContent).not.toContain('needle=');
  act(() => {
    jest.advanceTimersByTime(400);
  });
  const search = screen.getByTestId('search').textContent ?? '';
  expect(search).toContain('needle=evil-ioc');
  expect(search).toContain('start=6h');
});

it('only the last keystroke in a burst lands', () => {
  renderProbe('/explore');
  const input = screen.getByLabelText('needle');
  fireEvent.change(input, { target: { value: 'e' } });
  fireEvent.change(input, { target: { value: 'ev' } });
  fireEvent.change(input, { target: { value: 'evil' } });
  act(() => {
    jest.advanceTimersByTime(400);
  });
  expect(screen.getByTestId('search').textContent).toContain('needle=evil');
});

it("clearing the input deletes the param instead of leaving 'needle='", () => {
  renderProbe('/explore?needle=old');
  fireEvent.change(screen.getByLabelText('needle'), { target: { value: '' } });
  act(() => {
    jest.advanceTimersByTime(400);
  });
  expect(screen.getByTestId('search').textContent).not.toContain('needle');
});
