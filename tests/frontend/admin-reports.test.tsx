// @vitest-environment jsdom
/**
 * Frontend tests - admin lunch report.
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
import { AdminReportsPage } from '../../src/frontend/pages/admin/AdminReportsPage.js';
import { renderWithProviders, stubFetch, ADMIN_USER, SESSION_USER, ok, fail } from './helpers.js';

const ME = '/api/auth/me';
const REPORT = '/api/admin/reports/lunch';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function reportBody(overrides: Record<string, unknown> = {}) {
  return {
    date: '2027-03-01',
    timezone: 'Asia/Amman',
    menu: { exists: true, published: true, status: 'published' },
    totals: { employees_considered: 10, eligible: 6, not_eligible: 4 },
    selections: {
      option_1: 3,
      option_2: 2,
      no_preference: 1,
      eligible_not_selected: 0,
      ineligible_with_selection: 0,
    },
    eligibility: {
      by_reason: [
        { reason: 'REGULAR_WORKING_DAY', label: 'Regular employee on a working day', count: 4 },
        { reason: 'SHIFT_DAY', label: 'Shift employee on a day shift', count: 2 },
        { reason: 'SHIFT_OFF', label: 'Shift employee rostered off', count: 4 },
      ],
    },
    not_eligible: {
      by_reason: [{ reason: 'SHIFT_OFF', label: 'Shift employee rostered off', count: 4 }],
    },
    ...overrides,
  };
}

const routes = (overrides: Record<string, { status?: number; body: unknown }> = {}) => ({
  [ME]: ok(ADMIN_USER),
  [REPORT]: ok(reportBody()),
  ...overrides,
});

// ============================================================================
// ACCESS
// ============================================================================

describe('Admin report - access', () => {
  it('is reachable from the admin area', async () => {
    stubFetch(routes());
    renderWithProviders(<App />, { route: '/admin/reports' });
    expect(await screen.findByRole('heading', { name: 'Lunch report' })).toBeInTheDocument();
  });

  it('is not reachable by an employee', async () => {
    stubFetch({ [ME]: ok(SESSION_USER) });
    renderWithProviders(<App />, { route: '/admin/reports' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Lunch report' })).not.toBeInTheDocument()
    );
  });

  it('surfaces a server 403 rather than rendering a report', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [REPORT]: fail(403, 'Forbidden') });
    renderWithProviders(<AdminReportsPage />);

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Portions to prepare' })).not.toBeInTheDocument();
  });
});

// ============================================================================
// STATES
// ============================================================================

describe('Admin report - states', () => {
  it('shows a loading state', async () => {
    stubFetch(routes(), { delayPaths: [REPORT] });
    renderWithProviders(<AdminReportsPage />);
    expect(await screen.findByText('Building the report…')).toBeInTheDocument();
  });

  it('shows an error state', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [REPORT]: fail(500, 'The report could not be loaded.') });
    renderWithProviders(<AdminReportsPage />);
    expect(await screen.findByText('The report could not be loaded.')).toBeInTheDocument();
  });

  it('asks the server for the date rather than deriving one', async () => {
    const fetchMock = stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);
    await screen.findByRole('heading', { name: 'Portions to prepare' });

    // The first request carries no date at all.
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/reports/lunch'));
    expect(String(call![0])).toBe('/api/admin/reports/lunch');
  });

  it('reports the date and timezone the server resolved', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);

    const note = await screen.findByText(/as the server reckons the business date/i);
    expect(note).toHaveTextContent('2027-03-01');
    expect(note).toHaveTextContent('Asia/Amman');
  });

  it('requests an explicitly chosen date', async () => {
    const fetchMock = stubFetch({
      [ME]: ok(ADMIN_USER),
      [REPORT]: ok(reportBody()),
      [`${REPORT}?date=2027-03-05`]: ok(reportBody({ date: '2027-03-05' })),
    });
    const user = userEvent.setup();

    renderWithProviders(<AdminReportsPage />);
    await screen.findByRole('heading', { name: 'Portions to prepare' });

    // fireEvent.change is the reliable way to set a native date input; typing
    // into one produces partial values as each segment is filled.
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2027-03-05' } });
    await user.click(screen.getByRole('button', { name: 'Show report' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('date=2027-03-05'))).toBe(true)
    );
  });
});

// ============================================================================
// NO PUBLISHED MENU
// ============================================================================

describe('Admin report - menu state', () => {
  it('says plainly when there is no menu, without implying nobody wanted lunch', async () => {
    stubFetch(
      routes({
        [REPORT]: ok(
          reportBody({
            menu: { exists: false, published: false, status: null },
            selections: {
              option_1: 0, option_2: 0, no_preference: 0,
              eligible_not_selected: 6, ineligible_with_selection: 0,
            },
          })
        ),
      })
    );

    renderWithProviders(<AdminReportsPage />);

    expect(await screen.findByRole('heading', { name: 'No published lunch menu' })).toBeInTheDocument();
    expect(screen.getByText('There is no lunch menu for this date.')).toBeInTheDocument();
    expect(screen.getByText(/not because nobody wanted to/i)).toBeInTheDocument();
  });

  it('names a DRAFT menu as unselectable', async () => {
    stubFetch(
      routes({ [REPORT]: ok(reportBody({ menu: { exists: true, published: false, status: 'draft' } })) })
    );
    renderWithProviders(<AdminReportsPage />);
    expect(await screen.findByText(/menu for this date is draft/i)).toBeInTheDocument();
  });

  it('names an ARCHIVED menu as unselectable', async () => {
    stubFetch(
      routes({ [REPORT]: ok(reportBody({ menu: { exists: true, published: false, status: 'archived' } })) })
    );
    renderWithProviders(<AdminReportsPage />);
    expect(await screen.findByText(/menu for this date is archived/i)).toBeInTheDocument();
  });

  it('does NOT show the no-menu banner when the menu is published', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);
    await screen.findByRole('heading', { name: 'Portions to prepare' });
    expect(screen.queryByRole('heading', { name: 'No published lunch menu' })).not.toBeInTheDocument();
  });
});

// ============================================================================
// COUNTS
// ============================================================================

describe('Admin report - counts', () => {
  it('shows the selection breakdown', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);

    const section = (await screen.findByRole('heading', { name: 'Portions to prepare' })).closest('section')!;
    const items = within(section).getAllByRole('listitem').map((i) => i.textContent?.replace(/\s+/g, ' ').trim());

    expect(items).toEqual([
      '3 Option 1',
      '2 Option 2',
      '1 No preference',
      '0 Eligible, not selected',
    ]);
  });

  it('shows the eligibility totals', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);

    const section = (await screen.findByRole('heading', { name: 'Who was considered' })).closest('section')!;
    const items = within(section).getAllByRole('listitem').map((i) => i.textContent?.replace(/\s+/g, ' ').trim());

    expect(items).toEqual(['10 employees considered', '6 eligible', '4 not eligible']);
  });

  it('explains that No Preference is a choice, not a third menu option', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);

    expect(
      await screen.findByText(/an employee’s choice, not a menu option/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('Option 3')).not.toBeInTheDocument();
  });

  it('surfaces selections held by now-ineligible employees', async () => {
    stubFetch(
      routes({
        [REPORT]: ok(
          reportBody({
            selections: {
              option_1: 3, option_2: 2, no_preference: 1,
              eligible_not_selected: 0, ineligible_with_selection: 2,
            },
          })
        ),
      })
    );
    renderWithProviders(<AdminReportsPage />);

    expect(await screen.findByText(/are held by employees who are/i)).toBeInTheDocument();
    expect(screen.getByText(/not counted as portions/i)).toBeInTheDocument();
  });

  it('hides the ineligible-selection note when there are none', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);
    await screen.findByRole('heading', { name: 'Who was considered' });
    expect(screen.queryByText(/not counted as portions/i)).not.toBeInTheDocument();
  });
});

// ============================================================================
// REASON BREAKDOWN
// ============================================================================

describe('Admin report - reason breakdown', () => {
  it('lists each reason with its label, authoritative code and count', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);

    const section = (await screen.findByRole('heading', { name: 'Why employees were not eligible' })).closest('section')!;
    const row = within(section).getByText('SHIFT_OFF').closest('tr')!;

    expect(row).toHaveTextContent('Shift employee rostered off');
    expect(row).toHaveTextContent('SHIFT_OFF');
    expect(row).toHaveTextContent('4');
  });

  it('shows the full eligibility breakdown, eligible reasons included', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);

    const section = (await screen.findByRole('heading', { name: 'Eligibility breakdown' })).closest('section')!;
    expect(within(section).getByText('REGULAR_WORKING_DAY')).toBeInTheDocument();
    expect(within(section).getByText('SHIFT_DAY')).toBeInTheDocument();
  });

  it('says so when every employee was eligible', async () => {
    stubFetch(routes({ [REPORT]: ok(reportBody({ not_eligible: { by_reason: [] } })) }));
    renderWithProviders(<AdminReportsPage />);
    expect(await screen.findByText('Every employee considered was eligible.')).toBeInTheDocument();
  });

  it('renders reason tables with accessible column headers', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);

    const section = (await screen.findByRole('heading', { name: 'Eligibility breakdown' })).closest('section')!;
    expect(within(section).getByRole('columnheader', { name: 'Reason' })).toBeInTheDocument();
    expect(within(section).getByRole('columnheader', { name: 'Code' })).toBeInTheDocument();
    expect(within(section).getByRole('columnheader', { name: 'Employees' })).toBeInTheDocument();
  });
});

// ============================================================================
// SECRETS
// ============================================================================

describe('Admin report - handles no credentials', () => {
  it('stores nothing in the browser and sends no credentials', async () => {
    const fetchMock = stubFetch(routes());
    localStorage.clear();
    sessionStorage.clear();

    renderWithProviders(<AdminReportsPage />);
    await screen.findByRole('heading', { name: 'Portions to prepare' });

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

  it('computes no eligibility of its own', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminReportsPage />);
    await screen.findByRole('heading', { name: 'Eligibility breakdown' });

    // Every reason string shown came from the server payload.
    expect(screen.getByText('Regular employee on a working day')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/You are eligible/i);
  });
});
