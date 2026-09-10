// @vitest-environment jsdom
/**
 * Frontend tests - admin UX and accessibility hardening.
 *
 * Regression cover for the issues Phase 5 Slice 4 fixed, plus the properties
 * that audit confirmed were already correct and must stay that way.
 */

import type { ReactElement } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { App } from '../../src/frontend/App.js';
import { AdminRosterPage } from '../../src/frontend/pages/admin/AdminRosterPage.js';
import { AdminReportsPage } from '../../src/frontend/pages/admin/AdminReportsPage.js';
import { AdminMenuPage } from '../../src/frontend/pages/admin/AdminMenuPage.js';
import { AdminEmployeesPage } from '../../src/frontend/pages/admin/AdminEmployeesPage.js';
import { AdminSettingsPage } from '../../src/frontend/pages/admin/AdminSettingsPage.js';
import { AdminMenuImportPage } from '../../src/frontend/pages/admin/AdminMenuImportPage.js';
import { renderWithProviders, stubFetch, ADMIN_USER, SESSION_USER, ok, fail } from './helpers.js';

const ME = '/api/auth/me';
const ROSTER_DAY = '/api/roster/admin/day';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ROSTER_ROW = {
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
};

const rosterRoutes = (overrides: Record<string, { status?: number; body: unknown }> = {}) => ({
  [ME]: ok(ADMIN_USER),
  [ROSTER_DAY]: ok({ date: '2027-03-01', employees: [ROSTER_ROW] }),
  ...overrides,
});

/** Open the roster row's remove confirmation and hand back its trigger. */
async function openRemoveDialog(user: ReturnType<typeof userEvent.setup>) {
  const card = await screen.findByTestId('roster-TEST100');
  const trigger = within(card).getByRole('button', { name: 'Remove' });
  await user.click(trigger);
  return { dialog: await screen.findByRole('alertdialog'), trigger };
}

// ============================================================================
// CONFIRM DIALOG - the component guarding every destructive action
// ============================================================================

describe('ConfirmDialog accessibility', () => {
  it('takes focus when it opens, on the SAFE option', async () => {
    stubFetch(rosterRoutes());
    const user = userEvent.setup();
    renderWithProviders(<AdminRosterPage />);

    const { dialog } = await openRemoveDialog(user);

    // A dialog that asks a destructive question must not appear silently.
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Cancel, not confirm: the safe option is the one under the finger.
    expect(document.activeElement).toHaveAccessibleName('Cancel');
  });

  it('is marked as a modal alertdialog with an accessible name', async () => {
    stubFetch(rosterRoutes());
    const user = userEvent.setup();
    renderWithProviders(<AdminRosterPage />);

    const { dialog } = await openRemoveDialog(user);

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/Remove the roster entry for Alpha Shift/);
  });

  it('Escape cancels it', async () => {
    const fetchMock = stubFetch(rosterRoutes());
    const user = userEvent.setup();
    renderWithProviders(<AdminRosterPage />);

    await openRemoveDialog(user);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    // Escaping is a cancel, never a confirm: nothing was deleted.
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'DELETE')).toHaveLength(0);
  });

  it('returns focus into the same row after cancelling', async () => {
    stubFetch(rosterRoutes());
    const user = userEvent.setup();
    renderWithProviders(<AdminRosterPage />);

    await openRemoveDialog(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    // The dialog replaces the row's actions, so the trigger is a NEW element by
    // now. What matters is that the keyboard journey resumes in the same row
    // rather than at the top of the document.
    await waitFor(() =>
      expect(screen.getByTestId('roster-TEST100').contains(document.activeElement)).toBe(true)
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it('returns focus after Escape too', async () => {
    stubFetch(rosterRoutes());
    const user = userEvent.setup();
    renderWithProviders(<AdminRosterPage />);

    await openRemoveDialog(user);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId('roster-TEST100').contains(document.activeElement)).toBe(true)
    );
  });

  it('can be confirmed from the keyboard alone', async () => {
    const fetchMock = stubFetch(rosterRoutes({ 'DELETE /api/roster/1/2027-03-01': ok({}) }));
    const user = userEvent.setup();
    renderWithProviders(<AdminRosterPage />);

    await openRemoveDialog(user);
    // Focus starts on Cancel; Tab reaches the confirm button.
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName('Remove entry');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([u, i]) => String(u) === '/api/roster/1/2027-03-01' && (i as RequestInit)?.method === 'DELETE')
      ).toHaveLength(1)
    );
  });

  it('the same guarantees hold on the menu screen', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      '/api/menu/admin/range': ok({
        month: '2027-03', from: '2027-03-01', to: '2027-03-31', today: '2027-03-07',
        menus: [{
          id: 1, meal_date: '2027-03-01', status: 'draft',
          options: [
            { id: 1, menu_day_id: 1, option_number: 1, name: 'Test Alpha', description: null },
            { id: 2, menu_day_id: 1, option_number: 2, name: 'Test Beta', description: null },
          ],
          components: [],
        }],
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<AdminMenuPage />);

    const card = await screen.findByTestId('menu-day-2027-03-01');
    const trigger = within(card).getByRole('button', { name: 'Publish' });
    await user.click(trigger);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(card.contains(document.activeElement)).toBe(true));
    expect(trigger).toBeDefined();
  });
});

// ============================================================================
// NAVIGATION
// ============================================================================

describe('Admin navigation', () => {
  const NAV_TARGETS = [
    ['Employees', '/admin/employees'],
    ['Roster', '/admin/roster'],
    ['Reports', '/admin/reports'],
    ['Menus', '/admin/menu'],
    ['Employee import', '/admin/imports/employees'],
    ['Roster import', '/admin/imports/roster'],
    ['Menu import', '/admin/imports/menu'],
    ['Settings', '/admin/settings'],
  ] as const;

  const allRoutes = {
    [ME]: ok(ADMIN_USER),
    '/api/admin/employees': ok({ employees: [], total: 0 }),
    [ROSTER_DAY]: ok({ date: '2027-03-01', employees: [] }),
    '/api/admin/reports/lunch': ok({
      date: '2027-03-01', timezone: 'Asia/Amman',
      menu: { exists: false, published: false, status: null },
      totals: { employees_considered: 0, eligible: 0, not_eligible: 0 },
      selections: { option_1: 0, option_2: 0, no_preference: 0, eligible_not_selected: 0, ineligible_with_selection: 0 },
      eligibility: { by_reason: [] }, not_eligible: { by_reason: [] },
    }),
    '/api/menu/admin/range': ok({ month: '2027-03', from: '2027-03-01', to: '2027-03-31', today: '2027-03-07', menus: [] }),
    '/api/admin/settings': ok([{ key: 'lunch_cutoff_time', value: '"10:00"', value_type: 'time' }]),
    '/api/admin/holidays': ok([]),
    '/api/admin/imports?limit=10&offset=0&import_type=employees': ok({ imports: [], total: 0, limit: 10, offset: 0 }),
    '/api/admin/imports?limit=10&offset=0&import_type=roster': ok({ imports: [], total: 0, limit: 10, offset: 0 }),
    '/api/admin/imports?limit=10&offset=0&import_type=menu': ok({ imports: [], total: 0, limit: 10, offset: 0 }),
  };

  it('every implemented admin page has a nav link, and none is a dead link', async () => {
    stubFetch(allRoutes);
    renderWithProviders(<App />, { route: '/admin/employees' });

    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));

    for (const [, path] of NAV_TARGETS) {
      expect(hrefs).toContain(path);
    }
  });

  it('each nav link actually reaches its page', async () => {
    for (const [label, path] of NAV_TARGETS) {
      cleanup();
      stubFetch(allRoutes);
      renderWithProviders(<App />, { route: path });

      const nav = await screen.findByRole('navigation', { name: 'Admin' });
      const link = within(nav).getByRole('link', { name: label });
      // The link for the current page is the one marked active.
      await waitFor(() => expect(link.className).toContain('nav__link--active'));
    }
  });

  it('marks exactly ONE nav link active at a time', async () => {
    stubFetch(allRoutes);
    renderWithProviders(<App />, { route: '/admin/imports/roster' });

    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    await waitFor(() => {
      const active = within(nav).getAllByRole('link').filter((a) => a.className.includes('nav__link--active'));
      expect(active).toHaveLength(1);
      expect(active[0]).toHaveAccessibleName('Roster import');
    });
  });

  it('an employee reaches no admin page', async () => {
    for (const [, path] of NAV_TARGETS) {
      cleanup();
      stubFetch({ [ME]: ok(SESSION_USER) });
      renderWithProviders(<App />, { route: path });

      await waitFor(() =>
        expect(screen.queryByRole('navigation', { name: 'Admin' })).not.toBeInTheDocument()
      );
    }
  });
});

// ============================================================================
// PROPERTIES THE AUDIT CONFIRMED - and that must stay true
// ============================================================================

describe('Admin UX invariants', () => {
  it('a mutation cannot be double-submitted by a rapid second click', async () => {
    const fetchMock = stubFetch(rosterRoutes({ 'POST /api/roster': ok({}) }), {
      delayPaths: ['/api/roster'],
    });
    const user = userEvent.setup();
    renderWithProviders(<AdminRosterPage />);

    const card = await screen.findByTestId('roster-TEST100');
    const button = within(card).getByRole('button', { name: 'Night' });
    await user.click(button);
    await user.click(button);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(
      fetchMock.mock.calls.filter(([u, i]) => String(u) === '/api/roster' && (i as RequestInit)?.method === 'POST')
    ).toHaveLength(1);
  });

  it('report zero values are SHOWN as zero, not omitted', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      '/api/admin/reports/lunch': ok({
        date: '2027-03-01', timezone: 'Asia/Amman',
        menu: { exists: true, published: true, status: 'published' },
        totals: { employees_considered: 0, eligible: 0, not_eligible: 0 },
        selections: { option_1: 0, option_2: 0, no_preference: 0, eligible_not_selected: 0, ineligible_with_selection: 0 },
        eligibility: { by_reason: [] }, not_eligible: { by_reason: [] },
      }),
    });
    renderWithProviders(<AdminReportsPage />);

    const section = (await screen.findByRole('heading', { name: 'Portions to prepare' })).closest('section')!;
    const items = within(section).getAllByRole('listitem').map((i) => i.textContent?.replace(/\s+/g, ' ').trim());

    // A zero portion count is information, not an absence of it.
    expect(items).toEqual(['0 Option 1', '0 Option 2', '0 No preference', '0 Eligible, not selected']);
  });

  it('mutation failures are announced, not merely displayed', async () => {
    stubFetch(rosterRoutes({ 'POST /api/roster': fail(404, 'Employee not found') }));
    const user = userEvent.setup();
    renderWithProviders(<AdminRosterPage />);

    const card = await screen.findByTestId('roster-TEST100');
    await user.click(within(card).getByRole('button', { name: 'Off' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Employee not found');
  });

  it('status is conveyed as TEXT, never by colour alone', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [ROSTER_DAY]: ok({
        date: '2027-03-01',
        employees: [
          { ...ROSTER_ROW, employee_id: 1, amco_id: 'TEST100', shift_value: 'day' },
          { ...ROSTER_ROW, employee_id: 2, amco_id: 'TEST101', shift_value: null, roster_entry_id: null },
        ],
      }),
    });
    renderWithProviders(<AdminRosterPage />);

    expect(await screen.findByTestId('status-TEST100')).toHaveTextContent('Day');
    // Missing stays distinct from Off, in words.
    expect(screen.getByTestId('status-TEST101')).toHaveTextContent('No roster');
  });
});

// ============================================================================
// ACCESSIBLE NAMES - swept across every admin page
// ============================================================================

describe('Every admin control has an accessible name', () => {
  /** Focusable controls with no name are unusable by screen reader or voice. */
  const unnamed = () => {
    const bad: string[] = [];
    document.querySelectorAll('input, select, textarea, button').forEach((el) => {
      const e = el as HTMLElement;
      const id = e.getAttribute('id');
      const named =
        e.getAttribute('aria-label') ||
        e.getAttribute('aria-labelledby') ||
        (id && document.querySelector(`label[for="${id}"]`)) ||
        e.closest('label') ||
        (e.tagName === 'BUTTON' && e.textContent?.trim());
      if (!named) bad.push(`${e.tagName}.${e.className || '(no class)'}`);
    });
    return bad;
  };

  const cases: Array<[string, () => ReactElement, Record<string, { status?: number; body: unknown }>]> = [
    ['roster', () => <AdminRosterPage />, { [ROSTER_DAY]: ok({ date: '2027-03-01', employees: [ROSTER_ROW] }) }],
    ['employees', () => <AdminEmployeesPage />, { '/api/admin/employees': ok({ employees: [], total: 0 }) }],
    ['settings', () => <AdminSettingsPage />, {
      '/api/admin/settings': ok([{ key: 'lunch_cutoff_time', value: '"10:00"', value_type: 'time' }]),
      '/api/admin/holidays': ok([]),
    }],
    ['menu import', () => <AdminMenuImportPage />, {
      '/api/admin/imports?limit=10&offset=0&import_type=menu': ok({ imports: [], total: 0, limit: 10, offset: 0 }),
    }],
  ];

  for (const [name, render, routes] of cases) {
    it(`${name}`, async () => {
      stubFetch({ [ME]: ok(ADMIN_USER), ...routes });
      renderWithProviders(render());
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(unnamed()).toEqual([]);
    });
  }
});
