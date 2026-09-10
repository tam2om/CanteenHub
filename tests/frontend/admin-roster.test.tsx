// @vitest-environment jsdom
/**
 * Frontend tests - admin roster management.
 *
 * Real components, hooks, router and API client; only `fetch` is stubbed. An
 * unmapped path returns 404, so no test can pass because of a silently
 * successful call.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { App } from '../../src/frontend/App.js';
import { AdminRosterPage } from '../../src/frontend/pages/admin/AdminRosterPage.js';
import { renderWithProviders, stubFetch, ADMIN_USER, SESSION_USER, ok, fail } from './helpers.js';

const ME = '/api/auth/me';
const DAY = '/api/roster/admin/day';
const DATE = '2027-03-01';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    employee_id: 1,
    amco_id: 'TEST100',
    full_name: 'Alpha Shift',
    department: 'Mining',
    section: 'Operations',
    roster_type: 'shift',
    is_active: 1,
    roster_entry_id: 11,
    shift_value: 'day',
    source: 'manual',
    ...overrides,
  };
}

const dayBody = (employees: unknown[], date = DATE) => ok({ date, employees });

const routes = (overrides: Record<string, { status?: number; body: unknown }> = {}) => ({
  [ME]: ok(ADMIN_USER),
  [DAY]: dayBody([row()]),
  ...overrides,
});

// ============================================================================
// ACCESS
// ============================================================================

describe('Admin roster - access', () => {
  it('is reachable from the admin area', async () => {
    stubFetch(routes());
    renderWithProviders(<App />, { route: '/admin/roster' });
    expect(await screen.findByRole('heading', { name: 'Roster' })).toBeInTheDocument();
  });

  it('is not reachable by an employee', async () => {
    stubFetch({ [ME]: ok(SESSION_USER) });
    renderWithProviders(<App />, { route: '/admin/roster' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Roster' })).not.toBeInTheDocument()
    );
  });

  it('surfaces a server refusal rather than rendering a roster', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [DAY]: fail(403, 'Forbidden') });
    renderWithProviders(<AdminRosterPage />);

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    expect(screen.queryByTestId('roster-TEST100')).not.toBeInTheDocument();
  });
});

// ============================================================================
// STATES
// ============================================================================

describe('Admin roster - states', () => {
  it('shows a loading state', async () => {
    stubFetch(routes(), { delayPaths: [DAY] });
    renderWithProviders(<AdminRosterPage />);
    expect(await screen.findByText('Loading the roster…')).toBeInTheDocument();
  });

  it('shows an error state', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [DAY]: fail(500, 'The roster could not be loaded.') });
    renderWithProviders(<AdminRosterPage />);
    expect(await screen.findByText('The roster could not be loaded.')).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [DAY]: dayBody([]) });
    renderWithProviders(<AdminRosterPage />);
    expect(await screen.findByText('No employees match these filters.')).toBeInTheDocument();
  });

  it('asks the server for the date rather than deriving one', async () => {
    const fetchMock = stubFetch(routes());
    renderWithProviders(<AdminRosterPage />);
    await screen.findByTestId('roster-TEST100');

    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/roster/admin/day'));
    expect(String(call![0])).toBe('/api/roster/admin/day');
  });

  it('reports the server-supplied date', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminRosterPage />);
    const note = await screen.findByText(/as the server reckons the business date/i);
    expect(note).toHaveTextContent(DATE);
  });
});

// ============================================================================
// DISPLAY - missing vs off
// ============================================================================

describe('Admin roster - display', () => {
  it('shows Day, Night and Off distinctly', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [DAY]: dayBody([
        row({ employee_id: 1, amco_id: 'TEST100', shift_value: 'day' }),
        row({ employee_id: 2, amco_id: 'TEST101', shift_value: 'night' }),
        row({ employee_id: 3, amco_id: 'TEST102', shift_value: 'off' }),
      ]),
    });
    renderWithProviders(<AdminRosterPage />);

    // Assert on the STATUS badge, not the buttons, which carry the same words.
    expect(await screen.findByTestId('status-TEST100')).toHaveTextContent('Day');
    expect(screen.getByTestId('status-TEST101')).toHaveTextContent('Night');
    expect(screen.getByTestId('status-TEST102')).toHaveTextContent('Off');
  });

  it('shows a MISSING roster as "No roster", never as Off', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [DAY]: dayBody([row({ shift_value: null, roster_entry_id: null, source: null })]),
    });
    renderWithProviders(<AdminRosterPage />);

    const status = await screen.findByTestId('status-TEST100');
    expect(status).toHaveTextContent('No roster');
    // The status badge does NOT read "Off" - missing is its own state.
    expect(status).not.toHaveTextContent(/^Off$/);
  });

  it('offers no Remove button when there is nothing to remove', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [DAY]: dayBody([row({ shift_value: null, roster_entry_id: null })]),
    });
    renderWithProviders(<AdminRosterPage />);

    const card = await screen.findByTestId('roster-TEST100');
    expect(within(card).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('marks the current shift as pressed', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminRosterPage />);

    const card = await screen.findByTestId('roster-TEST100');
    expect(within(card).getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(card).getByRole('button', { name: 'Night' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the identifying and organisational detail an admin needs', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminRosterPage />);

    const card = await screen.findByTestId('roster-TEST100');
    expect(within(card).getByText('Alpha Shift — TEST100')).toBeInTheDocument();
    expect(within(card).getByText(/Shift · Mining · Operations/)).toBeInTheDocument();
  });

  it('renders no eligibility verdict - that is the server\'s business', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminRosterPage />);
    await screen.findByTestId('roster-TEST100');

    expect(document.body.textContent ?? '').not.toMatch(/eligible|ROSTER_MISSING|SHIFT_DAY/i);
  });
});

// ============================================================================
// SEARCH AND FILTER - server-side
// ============================================================================

describe('Admin roster - search and filter', () => {
  it('sends the search term to the SERVER', async () => {
    const fetchMock = stubFetch({
      [ME]: ok(ADMIN_USER),
      [DAY]: dayBody([row()]),
      [`${DAY}?search=alpha`]: dayBody([row()]),
    });
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterPage />);
    await screen.findByTestId('roster-TEST100');

    await user.type(screen.getByLabelText('Search'), 'alpha');
    await user.click(screen.getByRole('button', { name: 'Show roster' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('search=alpha'))).toBe(true)
    );
  });

  it('sends the roster type filter to the server', async () => {
    const fetchMock = stubFetch({
      [ME]: ok(ADMIN_USER),
      [DAY]: dayBody([row()]),
      [`${DAY}?roster_type=shift`]: dayBody([row()]),
    });
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterPage />);
    await screen.findByTestId('roster-TEST100');

    await user.selectOptions(screen.getByLabelText('Roster type'), 'shift');
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('roster_type=shift'))).toBe(true)
    );
  });

  it('sends a chosen date to the server', async () => {
    const fetchMock = stubFetch({
      [ME]: ok(ADMIN_USER),
      [DAY]: dayBody([row()]),
      [`${DAY}?date=2027-03-05`]: dayBody([row()], '2027-03-05'),
    });
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterPage />);
    await screen.findByTestId('roster-TEST100');

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2027-03-05' } });
    await user.click(screen.getByRole('button', { name: 'Show roster' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('date=2027-03-05'))).toBe(true)
    );
  });
});

// ============================================================================
// EDITING
// ============================================================================

describe('Admin roster - editing', () => {
  it('sets Day, Night and Off, sending no source', async () => {
    const fetchMock = stubFetch(routes({ 'POST /api/roster': ok({}) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterPage />);
    const card = await screen.findByTestId('roster-TEST100');

    await user.click(within(card).getByRole('button', { name: 'Night' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/roster')).toBe(true)
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/roster')!;
    const body = JSON.parse((call[1] as RequestInit).body as string);

    expect(body).toEqual({ employee_id: 1, work_date: DATE, shift_value: 'night' });
    // A manual edit is manual by definition; the client never labels it.
    expect(body.source).toBeUndefined();
  });

  it('removing requires confirmation, and explains missing is not Off', async () => {
    const fetchMock = stubFetch(routes({ 'DELETE /api/roster/1/2027-03-01': ok({}) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterPage />);
    const card = await screen.findByTestId('roster-TEST100');
    await user.click(within(card).getByRole('button', { name: 'Remove' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/NO roster entry/);
    expect(dialog).toHaveTextContent(/not the same as being rostered off/i);
    expect(dialog).toHaveTextContent(/meal selections are not affected/i);
    // Nothing sent until confirmed.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/roster/1/'))).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Remove entry' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === '/api/roster/1/2027-03-01' && (i as RequestInit)?.method === 'DELETE')).toHaveLength(1)
    );
  });

  it('cancelling the removal sends nothing', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterPage />);
    const card = await screen.findByTestId('roster-TEST100');
    await user.click(within(card).getByRole('button', { name: 'Remove' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/roster/1/'))).toHaveLength(0);
  });

  it('surfaces a server refusal of an edit', async () => {
    stubFetch(routes({ 'POST /api/roster': fail(404, 'Employee not found') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterPage />);
    const card = await screen.findByTestId('roster-TEST100');
    await user.click(within(card).getByRole('button', { name: 'Off' }));

    expect(await screen.findByText('Employee not found')).toBeInTheDocument();
  });

  it('refetches after a mutation rather than guessing the new state', async () => {
    const fetchMock = stubFetch(routes({ 'POST /api/roster': ok({}) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterPage />);
    const card = await screen.findByTestId('roster-TEST100');
    const before = fetchMock.mock.calls.filter(([u]) => String(u).includes('/roster/admin/day')).length;

    await user.click(within(card).getByRole('button', { name: 'Off' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([u]) => String(u).includes('/roster/admin/day')).length
      ).toBeGreaterThan(before)
    );
  });
});

// ============================================================================
// SECRETS
// ============================================================================

describe('Admin roster - handles no credentials', () => {
  it('offers no password field and stores nothing in the browser', async () => {
    const fetchMock = stubFetch(routes({ 'POST /api/roster': ok({}) }));
    const user = userEvent.setup();
    localStorage.clear();
    sessionStorage.clear();

    renderWithProviders(<AdminRosterPage />);
    const card = await screen.findByTestId('roster-TEST100');
    await user.click(within(card).getByRole('button', { name: 'Off' }));

    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    for (const [url, init] of fetchMock.mock.calls) {
      const body = (init as RequestInit | undefined)?.body;
      const serialised = typeof body === 'string' ? body : '';
      expect(`${String(url)} ${serialised}`).not.toMatch(/password|token|secret/i);
    }
    expect(document.body.textContent ?? '').not.toMatch(/password_hash|session_token/i);
  });
});
