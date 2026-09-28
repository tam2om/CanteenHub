// @vitest-environment jsdom
/**
 * Frontend tests - what each role is SHOWN in the admin area.
 *
 * Display only: the server refuses every one of these actions regardless (see
 * tests/integration/roles-supervisor.test.ts). What is tested here is that the
 * screen never offers a button whose only possible outcome is a 403.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { App } from '../../src/frontend/App.js';
import {
  renderWithProviders,
  stubFetch,
  adminEmployee,
  ADMIN_USER,
  SESSION_USER,
  todayPayload,
  ok,
} from './helpers.js';

const ME = '/api/auth/me';
const EMPLOYEES = '/api/admin/employees';
const TODAY = '/api/me/today';

const SUPERVISOR_USER = { ...ADMIN_USER, id: 902, amco_id: 'TEST902', full_name: 'Test Supervisor', role: 'supervisor' };
const SUPER_ADMIN_USER = { ...ADMIN_USER, id: 903, amco_id: 'TEST903', full_name: 'Test Super', role: 'super_admin' };

// One of each role, so every rule is visible in one list.
const PEOPLE = [
  adminEmployee({ id: 11, amco_id: 'TEST011', full_name: 'Plain Employee', role_id: 1 }),
  adminEmployee({ id: 12, amco_id: 'TEST012', full_name: 'Other Supervisor', role_id: 4 }),
  adminEmployee({ id: 13, amco_id: 'TEST013', full_name: 'Some Admin', role_id: 2 }),
  adminEmployee({ id: 14, amco_id: 'TEST014', full_name: 'Top Super', role_id: 3 }),
];

const routesFor = (user: unknown) => ({
  [ME]: ok(user),
  [EMPLOYEES]: ok({ employees: PEOPLE, total: PEOPLE.length }),
  [TODAY]: ok(todayPayload()),
});

/** The action buttons offered on one person's row, by name. */
const actionsFor = (fullName: string) => {
  const item = screen.getByText(fullName).closest('li')!;
  return within(item)
    .queryAllByRole('button')
    .map((b) => b.textContent?.trim());
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('A supervisor', () => {
  it('sees only Employees and Reports in the admin navigation', async () => {
    stubFetch(routesFor(SUPERVISOR_USER));
    renderWithProviders(<App />, { route: '/admin/employees' });

    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    const links = within(nav).getAllByRole('link').map((l) => l.textContent?.trim());
    expect(links).toEqual(['Employees', 'Reports', 'My portal']);
    expect(screen.getByText(/· Supervisor$/)).toBeInTheDocument();
  });

  it('cannot add employees, set passwords or deactivate anyone', async () => {
    stubFetch(routesFor(SUPERVISOR_USER));
    renderWithProviders(<App />, { route: '/admin/employees' });
    await screen.findByText('Plain Employee');

    expect(screen.queryByRole('button', { name: 'Add employee' })).not.toBeInTheDocument();
    expect(actionsFor('Plain Employee')).toEqual(['Edit']);
  });

  it('is offered nothing on supervisors or administrators', async () => {
    stubFetch(routesFor(SUPERVISOR_USER));
    renderWithProviders(<App />, { route: '/admin/employees' });
    await screen.findByText('Plain Employee');

    expect(actionsFor('Other Supervisor')).toEqual([]);
    expect(actionsFor('Some Admin')).toEqual([]);
    expect(actionsFor('Top Super')).toEqual([]);
  });

  it('edits details with no Role field on the form', async () => {
    const user = userEvent.setup();
    stubFetch(routesFor(SUPERVISOR_USER));
    renderWithProviders(<App />, { route: '/admin/employees' });

    const item = (await screen.findByText('Plain Employee')).closest('li')!;
    await user.click(within(item).getByRole('button', { name: 'Edit' }));

    expect(within(item).getByLabelText(/Name/)).toBeInTheDocument();
    expect(within(item).queryByText('Role')).not.toBeInTheDocument();
  });

  it('following a link to an admin-only page lands on Employees instead', async () => {
    stubFetch(routesFor(SUPERVISOR_USER));
    renderWithProviders(<App />, { route: '/admin/settings' });

    expect(await screen.findByRole('heading', { name: 'Employees' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Settings/ })).not.toBeInTheDocument();
  });

  it('keeps their own portal, with a way into the supervisor area', async () => {
    stubFetch(routesFor(SUPERVISOR_USER));
    renderWithProviders(<App />, { route: '/' });

    expect(await screen.findByRole('link', { name: 'Supervisor' })).toBeInTheDocument();
  });
});

describe('An administrator', () => {
  it('can make someone a supervisor', async () => {
    const user = userEvent.setup();
    stubFetch(routesFor(ADMIN_USER));
    renderWithProviders(<App />, { route: '/admin/employees' });

    const item = (await screen.findByText('Plain Employee')).closest('li')!;
    await user.click(within(item).getByRole('button', { name: 'Edit' }));

    const role = within(item).getByRole('combobox', { name: /Role/ });
    expect(within(role).getByRole('option', { name: 'Supervisor' })).toBeInTheDocument();
  });

  it('has full actions on employees, supervisors and administrators', async () => {
    stubFetch(routesFor(ADMIN_USER));
    renderWithProviders(<App />, { route: '/admin/employees' });
    await screen.findByText('Plain Employee');

    for (const name of ['Plain Employee', 'Other Supervisor', 'Some Admin']) {
      expect(actionsFor(name)).toEqual(['Edit', 'Set password', 'Deactivate']);
    }
  });

  it('is offered NOTHING on a super administrator - not even Set password', async () => {
    stubFetch(routesFor(ADMIN_USER));
    renderWithProviders(<App />, { route: '/admin/employees' });
    await screen.findByText('Top Super');

    expect(actionsFor('Top Super')).toEqual([]);
  });
});

describe('A super administrator', () => {
  it('has full actions on everyone, other super administrators included', async () => {
    stubFetch(routesFor(SUPER_ADMIN_USER));
    renderWithProviders(<App />, { route: '/admin/employees' });
    await screen.findByText('Top Super');

    expect(actionsFor('Top Super')).toEqual(['Edit', 'Set password', 'Deactivate']);
  });
});

describe('An ordinary employee', () => {
  it('sees no way into the admin area, and is sent back if they try', async () => {
    stubFetch(routesFor(SESSION_USER));
    renderWithProviders(<App />, { route: '/admin/employees' });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Employees' })).not.toBeInTheDocument()
    );
    expect(screen.queryByRole('link', { name: /Admin|Supervisor/ })).not.toBeInTheDocument();
  });
});
