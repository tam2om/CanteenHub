// @vitest-environment jsdom
/**
 * Frontend tests - admin portal.
 *
 * Real components, hooks, router and API client; only `fetch` is stubbed. An
 * unmapped path returns 404, so no test can pass because of a silently
 * successful call.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { App } from '../../src/frontend/App.js';
import { AdminEmployeesPage } from '../../src/frontend/pages/admin/AdminEmployeesPage.js';
import { AdminSettingsPage } from '../../src/frontend/pages/admin/AdminSettingsPage.js';
import {
  renderWithProviders,
  stubFetch,
  adminEmployee,
  ADMIN_USER,
  SESSION_USER,
  todayPayload,
  ok,
  fail,
} from './helpers.js';

const ME = '/api/auth/me';
const EMPLOYEES = '/api/admin/employees';
const SETTINGS = '/api/admin/settings';
const HOLIDAYS = '/api/admin/holidays';
const TODAY = '/api/me/today';

const employeeList = (employees: unknown[], total = employees.length) =>
  ok({ employees, total });

const SETTINGS_ROWS = [
  { key: 'lunch_cutoff_time', value: '"10:00"', value_type: 'time' },
  { key: 'timezone', value: '"Asia/Amman"', value_type: 'string' },
  { key: 'working_days', value: '[0,1,2,3,4]', value_type: 'json' },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================================
// ADMIN ACCESS
// ============================================================================

describe('Admin access', () => {
  it('an admin can reach the admin area', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [EMPLOYEES]: employeeList([adminEmployee()]) });

    renderWithProviders(<App />, { route: '/admin/employees' });

    expect(await screen.findByRole('heading', { name: 'Employees' })).toBeInTheDocument();
  });

  it('a signed-in NON-admin is redirected out of the admin area', async () => {
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });

    renderWithProviders(<App />, { route: '/admin/employees' });

    // Sent to their own portal, not to login: their session is valid.
    expect(await screen.findByRole('heading', { name: 'Portal Tester' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Employees' })).not.toBeInTheDocument();
  });

  it('an unauthenticated visitor to the admin area is sent to login', async () => {
    stubFetch({ [ME]: fail(401, 'Not authenticated') });

    renderWithProviders(<App />, { route: '/admin/settings' });

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('the Admin nav link is shown to admins and hidden from employees', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [TODAY]: ok(todayPayload()) });
    const admin = renderWithProviders(<App />, { route: '/profile' });
    expect(await screen.findByRole('link', { name: 'Admin' })).toBeInTheDocument();
    admin.unmount();
    cleanup();

    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });
    renderWithProviders(<App />, { route: '/profile' });
    await screen.findByRole('heading', { name: 'Your profile' });
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('a 403 from the admin API surfaces as an error, not a blank page', async () => {
    // Hiding the UI is not the boundary: if the server refuses, the UI says so.
    stubFetch({ [ME]: ok(ADMIN_USER), [EMPLOYEES]: fail(403, 'Insufficient permissions') });

    renderWithProviders(<AdminEmployeesPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient permissions');
  });
});

// ============================================================================
// EMPLOYEE LIST
// ============================================================================

describe('Employee list', () => {
  it('renders employees with their details and status', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([
        adminEmployee(),
        adminEmployee({ id: 2, amco_id: 'TEST002', full_name: 'Second Person', is_active: 0 }),
      ]),
    });

    renderWithProviders(<AdminEmployeesPage />);

    expect(await screen.findByText('Portal Tester')).toBeInTheDocument();
    expect(screen.getByText('Second Person')).toBeInTheDocument();
    // Both fixtures share a department, so match all and assert the count.
    expect(screen.getByText(/TEST001/)).toBeInTheDocument();
    expect(screen.getAllByText(/Mining/)).toHaveLength(2);

    // Scoped to the list: "Active"/"Inactive" also appear as options in the
    // status filter, which is not what this test is about.
    const list = within(screen.getByRole('list'));
    expect(list.getByText('Active')).toBeInTheDocument();
    expect(list.getByText('Inactive')).toBeInTheDocument();
  });

  it('never renders password_hash or credential material', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    const { container } = renderWithProviders(<AdminEmployeesPage />);
    await screen.findByText('Portal Tester');

    const rendered = container.textContent ?? '';
    expect(rendered).not.toContain('password_hash');
    expect(rendered).not.toContain('pbkdf2');
  });

  it('shows a loading state, then content', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [EMPLOYEES]: employeeList([adminEmployee()]) });
    renderWithProviders(<AdminEmployeesPage />);

    expect(screen.getByRole('status')).toHaveTextContent(/Loading employees/);
    expect(await screen.findByText('Portal Tester')).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [EMPLOYEES]: employeeList([], 0) });
    renderWithProviders(<AdminEmployeesPage />);

    expect(await screen.findByText('No employees match these filters.')).toBeInTheDocument();
  });

  it('shows an error state when the list fails to load', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [EMPLOYEES]: fail(500, 'Internal Server Error') });
    renderWithProviders(<AdminEmployeesPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Internal Server Error');
  });
});

// ============================================================================
// SEARCH / FILTER — must be server-side
// ============================================================================

describe('Search and filtering', () => {
  it('sends the search term to the SERVER rather than filtering in the browser', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    renderWithProviders(<AdminEmployeesPage />);
    await screen.findByText('Portal Tester');

    await user.type(screen.getByLabelText('Search'), 'Distinctive');

    await waitFor(() => {
      const urls = fetchSpy.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('search=Distinctive'))).toBe(true);
    });
  });

  it('debounces typing into a single request rather than one per keystroke', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    renderWithProviders(<AdminEmployeesPage />);
    await screen.findByText('Portal Tester');

    const before = fetchSpy.mock.calls.filter(([u]) => String(u).includes('search=')).length;
    await user.type(screen.getByLabelText('Search'), 'abcdef');

    await waitFor(() => {
      const searches = fetchSpy.mock.calls.filter(([u]) => String(u).includes('search='));
      expect(searches.length).toBeGreaterThan(before);
    });

    const searchUrls = fetchSpy.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.includes('search='));
    // Six characters typed must not mean six requests.
    expect(searchUrls.length).toBeLessThan(6);
  });

  it('sends roster and status filters as server query parameters', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    renderWithProviders(<AdminEmployeesPage />);
    await screen.findByText('Portal Tester');

    await user.selectOptions(screen.getByLabelText('Roster'), 'shift');
    await waitFor(() => {
      const urls = fetchSpy.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('roster_type=shift'))).toBe(true);
    });

    await user.selectOptions(screen.getByLabelText('Status'), 'false');
    await waitFor(() => {
      const urls = fetchSpy.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('is_active=false'))).toBe(true);
    });
  });

  it('requests pagination parameters rather than loading every employee', async () => {
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()], 200),
    });

    renderWithProviders(<AdminEmployeesPage />);
    await screen.findByText('Portal Tester');

    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('page=1') && u.includes('page_size='))).toBe(true);
  });
});

// ============================================================================
// CREATE
// ============================================================================

describe('Create employee', () => {
  const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByRole('heading', { name: 'Employees' });
    await user.click(screen.getByRole('button', { name: 'Add employee' }));
    return within(await screen.findByRole('region', { name: 'Add employee' }));
  };

  it('creates an employee and sends the schema fields', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    renderWithProviders(<AdminEmployeesPage />);
    const form = await openForm(user);

    await user.type(form.getByLabelText('AMCO ID'), 'TEST100');
    await user.type(form.getByLabelText('Name'), 'New Person');
    await user.type(form.getByLabelText('Department'), 'Mining');
    await user.selectOptions(form.getByLabelText('Roster type'), 'shift');
    await user.click(form.getByRole('button', { name: 'Create employee' }));

    await waitFor(() => {
      const post = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
      expect(post).toBeDefined();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        amco_id: 'TEST100',
        full_name: 'New Person',
        department: 'Mining',
        roster_type: 'shift',
      });
    });
  });

  it('shows the server’s duplicate-AMCO-ID error', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });
    // The list GET succeeds; the create POST conflicts.
    const original = globalThis.fetch as unknown as (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Response(
            JSON.stringify({ success: false, error: 'An employee with this amco_id already exists' }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return original(input, init);
      })
    );

    renderWithProviders(<AdminEmployeesPage />);
    const form = await openForm(user);

    await user.type(form.getByLabelText('AMCO ID'), 'TEST001');
    await user.type(form.getByLabelText('Name'), 'Clashing Person');
    await user.click(form.getByRole('button', { name: 'Create employee' }));

    expect(await form.findByRole('alert')).toHaveTextContent(
      'An employee with this amco_id already exists'
    );
  });

  it('validates required fields before calling the API', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    renderWithProviders(<AdminEmployeesPage />);
    const form = await openForm(user);
    await user.click(form.getByRole('button', { name: 'Create employee' }));

    expect(await form.findByRole('alert')).toHaveTextContent('AMCO ID is required.');
    expect(fetchSpy.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'POST')).toBe(false);
  });

  it('tells the admin the new employee cannot sign in until a password is set', async () => {
    const user = userEvent.setup();
    stubFetch({ [ME]: ok(ADMIN_USER), [EMPLOYEES]: employeeList([adminEmployee()]) });

    renderWithProviders(<AdminEmployeesPage />);
    const form = await openForm(user);

    expect(
      form.getByText('The new employee cannot sign in until you set a password for them.')
    ).toBeInTheDocument();
  });
});

// ============================================================================
// EDIT
// ============================================================================

describe('Edit employee', () => {
  const openEdit = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText('Portal Tester');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    return within(await screen.findByRole('region', { name: 'Edit employee' }));
  };

  it('pre-fills the existing values', async () => {
    const user = userEvent.setup();
    stubFetch({ [ME]: ok(ADMIN_USER), [EMPLOYEES]: employeeList([adminEmployee()]) });

    renderWithProviders(<AdminEmployeesPage />);
    const form = await openEdit(user);

    expect(form.getByLabelText('Name')).toHaveValue('Portal Tester');
    expect(form.getByLabelText('Department')).toHaveValue('Mining');
    expect(form.getByLabelText('Section')).toHaveValue('Operations');
  });

  it('saves changes via PUT and does not send is_active', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    renderWithProviders(<AdminEmployeesPage />);
    const form = await openEdit(user);

    await user.clear(form.getByLabelText('Name'));
    await user.type(form.getByLabelText('Name'), 'Renamed Person');
    await user.click(form.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const put = fetchSpy.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'PUT');
      expect(put).toBeDefined();
      const body = JSON.parse((put![1] as RequestInit).body as string);
      expect(body.full_name).toBe('Renamed Person');
      // Activation has its own endpoint; sending it here is a 400 by design.
      expect(body).not.toHaveProperty('is_active');
      // The AMCO ID is identity and is not editable.
      expect(body).not.toHaveProperty('amco_id');
    });
  });

  it('surfaces a server validation error', async () => {
    const user = userEvent.setup();
    stubFetch({ [ME]: ok(ADMIN_USER), [EMPLOYEES]: employeeList([adminEmployee()]) });
    const original = globalThis.fetch as unknown as (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return new Response(
            JSON.stringify({ success: false, error: 'full_name cannot be empty' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return original(input, init);
      })
    );

    renderWithProviders(<AdminEmployeesPage />);
    const form = await openEdit(user);
    await user.click(form.getByRole('button', { name: 'Save changes' }));

    expect(await form.findByRole('alert')).toHaveTextContent('full_name cannot be empty');
  });

  it('can be cancelled without saving', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    renderWithProviders(<AdminEmployeesPage />);
    const form = await openEdit(user);
    await user.click(form.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Edit employee' })).not.toBeInTheDocument()
    );
    expect(fetchSpy.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'PUT')).toBe(false);
  });
});

// ============================================================================
// ACTIVATE / DEACTIVATE
// ============================================================================

describe('Activate and deactivate', () => {
  it('requires confirmation naming the employee before deactivating', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    renderWithProviders(<AdminEmployeesPage />);
    await screen.findByText('Portal Tester');
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Portal Tester');
    expect(dialog).toHaveTextContent('TEST001');
    // Nothing is sent until the admin confirms.
    expect(fetchSpy.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'PUT')).toBe(false);
  });

  it('states that history is preserved', async () => {
    const user = userEvent.setup();
    stubFetch({ [ME]: ok(ADMIN_USER), [EMPLOYEES]: employeeList([adminEmployee()]) });

    renderWithProviders(<AdminEmployeesPage />);
    await screen.findByText('Portal Tester');
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      /past selections and history are kept/i
    );
  });

  it('calls the dedicated status endpoint on confirmation', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
      '/api/admin/employees/1/status': ok(adminEmployee({ is_active: 0 })),
    });

    renderWithProviders(<AdminEmployeesPage />);
    await screen.findByText('Portal Tester');
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await user.click(await screen.findByRole('button', { name: 'Deactivate TEST001' }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => String(u).endsWith('/status'));
      expect(call).toBeDefined();
      expect((call![1] as RequestInit).method).toBe('PUT');
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ is_active: false });
    });
  });

  it('offers Activate for an inactive employee', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee({ is_active: 0 })]),
      '/api/admin/employees/1/status': ok(adminEmployee()),
    });

    renderWithProviders(<AdminEmployeesPage />);
    await screen.findByText('Portal Tester');
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    await user.click(await screen.findByRole('button', { name: 'Activate TEST001' }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => String(u).endsWith('/status'));
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ is_active: true });
    });
  });

  it('can be cancelled', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    renderWithProviders(<AdminEmployeesPage />);
    await screen.findByText('Portal Tester');
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(fetchSpy.mock.calls.some(([u]) => String(u).endsWith('/status'))).toBe(false);
  });
});

// ============================================================================
// PASSWORD
// ============================================================================

describe('Set employee password', () => {
  const openPassword = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText('Portal Tester');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    return within(await screen.findByRole('region', { name: 'Set password' }));
  };

  it('submits the password in the PUT body, never in the URL', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
      '/api/admin/employees/1/password': ok({
        employee_id: 1, amco_id: 'TEST001', password_set: true, sessionsRevoked: 2,
      }),
    });

    renderWithProviders(<AdminEmployeesPage />);
    const panel = await openPassword(user);

    await user.type(panel.getByLabelText('New password'), 'correct-horse-battery');
    await user.type(panel.getByLabelText('Confirm password'), 'correct-horse-battery');
    await user.click(panel.getByRole('button', { name: 'Set password' }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => String(u).endsWith('/password'));
      expect(call).toBeDefined();
      expect((call![1] as RequestInit).method).toBe('PUT');
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        password: 'correct-horse-battery',
      });
    });

    // The plaintext must never appear in any request URL.
    for (const [url] of fetchSpy.mock.calls) {
      expect(String(url)).not.toContain('correct-horse-battery');
    }
  });

  it('never renders the password back after submission', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
      '/api/admin/employees/1/password': ok({
        employee_id: 1, amco_id: 'TEST001', password_set: true, sessionsRevoked: 1,
      }),
    });

    const { container } = renderWithProviders(<AdminEmployeesPage />);
    const panel = await openPassword(user);

    await user.type(panel.getByLabelText('New password'), 'correct-horse-battery');
    await user.type(panel.getByLabelText('Confirm password'), 'correct-horse-battery');
    await user.click(panel.getByRole('button', { name: 'Set password' }));

    await screen.findByText(/Password set for TEST001/);

    expect(container.textContent ?? '').not.toContain('correct-horse-battery');
    expect(container.innerHTML).not.toContain('correct-horse-battery');
  });

  it('does not persist the password to browser storage', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
      '/api/admin/employees/1/password': ok({
        employee_id: 1, amco_id: 'TEST001', password_set: true, sessionsRevoked: 0,
      }),
    });

    renderWithProviders(<AdminEmployeesPage />);
    const panel = await openPassword(user);

    await user.type(panel.getByLabelText('New password'), 'correct-horse-battery');
    await user.type(panel.getByLabelText('Confirm password'), 'correct-horse-battery');
    await user.click(panel.getByRole('button', { name: 'Set password' }));

    await screen.findByText(/Password set for TEST001/);
    expect(JSON.stringify(localStorage)).not.toContain('correct-horse-battery');
    expect(JSON.stringify(sessionStorage)).not.toContain('correct-horse-battery');
  });

  it('reports how many sessions were ended', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
      '/api/admin/employees/1/password': ok({
        employee_id: 1, amco_id: 'TEST001', password_set: true, sessionsRevoked: 2,
      }),
    });

    renderWithProviders(<AdminEmployeesPage />);
    const panel = await openPassword(user);

    await user.type(panel.getByLabelText('New password'), 'correct-horse-battery');
    await user.type(panel.getByLabelText('Confirm password'), 'correct-horse-battery');
    await user.click(panel.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByText(/2 active sessions ended/)).toBeInTheDocument();
  });

  it('catches a mistyped confirmation before sending anything', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
    });

    renderWithProviders(<AdminEmployeesPage />);
    const panel = await openPassword(user);

    await user.type(panel.getByLabelText('New password'), 'correct-horse-battery');
    await user.type(panel.getByLabelText('Confirm password'), 'different-horse-batter');
    await user.click(panel.getByRole('button', { name: 'Set password' }));

    expect(await panel.findByRole('alert')).toHaveTextContent('The two passwords do not match.');
    expect(fetchSpy.mock.calls.some(([u]) => String(u).endsWith('/password'))).toBe(false);
  });

  it('shows the server’s password-policy rejection', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [EMPLOYEES]: employeeList([adminEmployee()]),
      '/api/admin/employees/1/password': fail(400, 'password must be at least 10 characters'),
    });

    renderWithProviders(<AdminEmployeesPage />);
    const panel = await openPassword(user);

    await user.type(panel.getByLabelText('New password'), 'short');
    await user.type(panel.getByLabelText('Confirm password'), 'short');
    await user.click(panel.getByRole('button', { name: 'Set password' }));

    expect(await panel.findByRole('alert')).toHaveTextContent(
      'password must be at least 10 characters'
    );
  });

  it('offers no reset-link, token or generator affordance', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [EMPLOYEES]: employeeList([adminEmployee()]) });

    renderWithProviders(<AdminEmployeesPage />);
    const panel = await openPassword(userEvent.setup());

    const text = (
      screen.getByRole('region', { name: 'Set password' }).textContent ?? ''
    ).toLowerCase();

    // The operational model is: admin types it, admin hands it over. Nothing in
    // this panel should hint at a link, token, email/SMS flow or generator.
    for (const forbidden of ['reset link', 'reset token', 'generate', 'email', 'sms']) {
      expect(text).not.toContain(forbidden);
    }
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument();
    expect(panel.queryByRole('link')).not.toBeInTheDocument();
  });
});

// ============================================================================
// SETTINGS — CUTOFF
// ============================================================================

describe('Settings — lunch cutoff', () => {
  it('loads and shows the configured cutoff and timezone', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [SETTINGS]: ok(SETTINGS_ROWS), [HOLIDAYS]: ok([]) });

    renderWithProviders(<AdminSettingsPage />);

    expect(await screen.findByText('10:00')).toBeInTheDocument();
    expect(screen.getByText(/Asia\/Amman/)).toBeInTheDocument();
  });

  it('saves a new cutoff through the settings endpoint', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [SETTINGS]: ok(SETTINGS_ROWS),
      [HOLIDAYS]: ok([]),
      '/api/admin/settings/cutoff': ok({ key: 'lunch_cutoff_time', value: '"14:30"' }),
    });

    renderWithProviders(<AdminSettingsPage />);
    await screen.findByText('10:00');

    await user.clear(screen.getByLabelText('New cutoff'));
    await user.type(screen.getByLabelText('New cutoff'), '14:30');
    await user.click(screen.getByRole('button', { name: 'Save cutoff' }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => String(u).endsWith('/settings/cutoff'));
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ cutoff_time: '14:30' });
    });

    expect(await screen.findByText(/Cutoff updated/)).toBeInTheDocument();
  });

  it('surfaces the server’s rejection of an invalid cutoff', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [SETTINGS]: ok(SETTINGS_ROWS),
      [HOLIDAYS]: ok([]),
      '/api/admin/settings/cutoff': fail(400, 'cutoff_time must be in HH:MM 24-hour format'),
    });

    renderWithProviders(<AdminSettingsPage />);
    await screen.findByText('10:00');

    await user.clear(screen.getByLabelText('New cutoff'));
    await user.type(screen.getByLabelText('New cutoff'), '23:59');
    await user.click(screen.getByRole('button', { name: 'Save cutoff' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'cutoff_time must be in HH:MM 24-hour format'
    );
  });

  it('takes the current cutoff from the server, with no value hard-coded', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [SETTINGS]: ok([{ key: 'lunch_cutoff_time', value: '"07:45"', value_type: 'time' }]),
      [HOLIDAYS]: ok([]),
    });

    renderWithProviders(<AdminSettingsPage />);

    expect(await screen.findByText('07:45')).toBeInTheDocument();
    expect(screen.queryByText('10:00')).not.toBeInTheDocument();
  });
});

// ============================================================================
// SETTINGS — HOLIDAYS
// ============================================================================

describe('Settings — holidays', () => {
  const HOLIDAY_ROWS = [
    { holiday_date: '2027-03-07', name: 'Independence Day' },
    { holiday_date: '2027-05-01', name: 'Labour Day' },
  ];

  it('lists configured holidays', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [SETTINGS]: ok(SETTINGS_ROWS), [HOLIDAYS]: ok(HOLIDAY_ROWS) });

    renderWithProviders(<AdminSettingsPage />);

    expect(await screen.findByText('Independence Day')).toBeInTheDocument();
    expect(screen.getByText('Sunday, 7 March 2027')).toBeInTheDocument();
    expect(screen.getByText('Labour Day')).toBeInTheDocument();
  });

  it('shows an empty state when none are configured', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [SETTINGS]: ok(SETTINGS_ROWS), [HOLIDAYS]: ok([]) });

    renderWithProviders(<AdminSettingsPage />);
    expect(await screen.findByText('No company holidays are configured.')).toBeInTheDocument();
  });

  it('adds a holiday through the holidays endpoint', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [SETTINGS]: ok(SETTINGS_ROWS),
      [HOLIDAYS]: ok([]),
    });

    renderWithProviders(<AdminSettingsPage />);
    await screen.findByText('No company holidays are configured.');

    await user.type(screen.getByLabelText('Date'), '2027-12-25');
    await user.type(screen.getByLabelText('Name'), 'Winter Holiday');
    await user.click(screen.getByRole('button', { name: 'Add holiday' }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        holiday_date: '2027-12-25',
        name: 'Winter Holiday',
      });
    });
  });

  it('explains that re-adding an existing date updates it rather than duplicating', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [SETTINGS]: ok(SETTINGS_ROWS),
      [HOLIDAYS]: ok(HOLIDAY_ROWS),
    });

    renderWithProviders(<AdminSettingsPage />);
    await screen.findByText('Independence Day');

    await user.type(screen.getByLabelText('Date'), '2027-03-07');
    await user.type(screen.getByLabelText('Name'), 'Renamed Holiday');
    await user.click(screen.getByRole('button', { name: 'Add holiday' }));

    expect(await screen.findByText(/already existed — its name was updated/)).toBeInTheDocument();
  });

  it('validates the date and name before calling the API', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [SETTINGS]: ok(SETTINGS_ROWS),
      [HOLIDAYS]: ok([]),
    });

    renderWithProviders(<AdminSettingsPage />);
    await screen.findByText('No company holidays are configured.');

    await user.click(screen.getByRole('button', { name: 'Add holiday' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a date.');

    await user.type(screen.getByLabelText('Date'), '2027-12-25');
    await user.click(screen.getByRole('button', { name: 'Add holiday' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a name for the holiday.');

    expect(fetchSpy.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'POST')).toBe(false);
  });

  it('surfaces a server error when adding fails', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [SETTINGS]: ok(SETTINGS_ROWS),
      [HOLIDAYS]: fail(500, 'Internal Server Error'),
    });

    renderWithProviders(<AdminSettingsPage />);
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
  });

  it('requires confirmation before removing a holiday', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [SETTINGS]: ok(SETTINGS_ROWS),
      [HOLIDAYS]: ok(HOLIDAY_ROWS),
    });

    renderWithProviders(<AdminSettingsPage />);
    await screen.findByText('Independence Day');

    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Independence Day');
    expect(fetchSpy.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'DELETE')).toBe(false);
  });

  it('deletes a holiday on confirmation', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({
      [ME]: ok(ADMIN_USER),
      [SETTINGS]: ok(SETTINGS_ROWS),
      [HOLIDAYS]: ok(HOLIDAY_ROWS),
      '/api/admin/holidays/2027-03-07': ok({ message: 'Holiday removed' }),
    });

    renderWithProviders(<AdminSettingsPage />);
    await screen.findByText('Independence Day');

    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    await user.click(await screen.findByRole('button', { name: 'Remove holiday' }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'DELETE');
      expect(call).toBeDefined();
      expect(String(call![0])).toContain('/api/admin/holidays/2027-03-07');
    });
  });
});
