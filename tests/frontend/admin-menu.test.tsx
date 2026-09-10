// @vitest-environment jsdom
/**
 * Frontend tests - admin lunch menu management.
 *
 * Real components, hooks, router and API client; only `fetch` is stubbed. An
 * unmapped path returns 404, so no test can pass because of a silently
 * successful call. Every dish name is invented.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { App } from '../../src/frontend/App.js';
import { AdminMenuPage } from '../../src/frontend/pages/admin/AdminMenuPage.js';
import { renderWithProviders, stubFetch, ADMIN_USER, SESSION_USER, ok, fail } from './helpers.js';

const ME = '/api/auth/me';
const RANGE = '/api/menu/admin/range';
const CREATE = 'POST /api/menu';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const option = (n: 1 | 2, name: string) => ({
  id: 100 + n,
  menu_day_id: 1,
  option_number: n,
  name,
  description: null,
});

function menuDay(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    meal_date: '2027-03-01',
    status: 'draft',
    options: [option(1, 'Test Main Alpha'), option(2, 'Test Main Beta')],
    components: [
      { id: 5, menu_day_id: 1, component_type: 'salad', name: 'Test Salad', sort_order: 0 },
    ],
    ...overrides,
  };
}

const month = (menus: unknown[], m = '2027-03') =>
  ok({ menus, month: m, from: `${m}-01`, to: `${m}-31`, today: '2027-03-07' });

function routes(overrides: Record<string, { status?: number; body: unknown }> = {}) {
  return {
    [ME]: ok(ADMIN_USER),
    [RANGE]: month([menuDay()]),
    ...overrides,
  };
}

// ============================================================================
// ACCESS AND LISTING
// ============================================================================

describe('Admin menu - access', () => {
  it('is reachable from the admin area', async () => {
    stubFetch(routes());
    renderWithProviders(<App />, { route: '/admin/menu' });
    expect(await screen.findByRole('heading', { name: 'Lunch menus' })).toBeInTheDocument();
  });

  it('is not reachable by an employee', async () => {
    stubFetch({ [ME]: ok(SESSION_USER) });
    renderWithProviders(<App />, { route: '/admin/menu' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Lunch menus' })).not.toBeInTheDocument()
    );
  });
});

describe('Admin menu - month listing', () => {
  it('asks the server for the month rather than deriving one', async () => {
    const fetchMock = stubFetch(routes());
    renderWithProviders(<AdminMenuPage />);
    await screen.findByTestId('current-month');

    // The first request carries no month at all: the server decides.
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/menu/admin/range'));
    expect(String(call![0])).toBe('/api/menu/admin/range');
  });

  it('shows the month and the server-supplied business date', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminMenuPage />);

    // Wait for the month to load, not merely for the element to exist.
    expect(await screen.findByText('2027-03-07')).toBeInTheDocument();
    expect(screen.getByTestId('current-month')).toHaveTextContent('2027-03');
  });

  it('navigates to the previous and next month via the server', async () => {
    const fetchMock = stubFetch({
      [ME]: ok(ADMIN_USER),
      [RANGE]: month([menuDay()]),
      [`${RANGE}?month=2027-02`]: month([], '2027-02'),
      [`${RANGE}?month=2027-04`]: month([], '2027-04'),
    });
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    await screen.findByTestId('current-month');

    await user.click(screen.getByRole('button', { name: '← Previous month' }));
    await waitFor(() => expect(screen.getByTestId('current-month')).toHaveTextContent('2027-02'));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('month=2027-02'))).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Next month →' }));
    await user.click(screen.getByRole('button', { name: 'Next month →' }));
    await waitFor(() => expect(screen.getByTestId('current-month')).toHaveTextContent('2027-04'));
  });

  it('rolls the year over correctly at a month boundary', async () => {
    const fetchMock = stubFetch({
      [ME]: ok(ADMIN_USER),
      [RANGE]: month([], '2027-01'),
      [`${RANGE}?month=2026-12`]: month([], '2026-12'),
    });
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    await screen.findByTestId('current-month');
    await user.click(screen.getByRole('button', { name: '← Previous month' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('month=2026-12'))).toBe(true)
    );
  });

  it('says so when a month has no menus', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [RANGE]: month([]) });
    renderWithProviders(<AdminMenuPage />);
    expect(await screen.findByText('No lunch menus for 2027-03 yet.')).toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [RANGE]: fail(500, 'The menus could not be loaded.') });
    renderWithProviders(<AdminMenuPage />);
    expect(await screen.findByText('The menus could not be loaded.')).toBeInTheDocument();
  });

  it('shows a loading state', async () => {
    stubFetch(routes(), { delayPaths: [RANGE] });
    renderWithProviders(<AdminMenuPage />);
    expect(await screen.findByText('Loading menus…')).toBeInTheDocument();
  });
});

// ============================================================================
// STATUS INDICATORS
// ============================================================================

describe('Admin menu - status', () => {
  it('distinguishes draft, published and archived, and says what each means', async () => {
    stubFetch({
      [ME]: ok(ADMIN_USER),
      [RANGE]: month([
        menuDay({ id: 1, meal_date: '2027-03-01', status: 'draft' }),
        menuDay({ id: 2, meal_date: '2027-03-02', status: 'published' }),
        menuDay({ id: 3, meal_date: '2027-03-03', status: 'archived' }),
      ]),
    });

    renderWithProviders(<AdminMenuPage />);

    const draft = await screen.findByTestId('menu-day-2027-03-01');
    expect(within(draft).getByText('Draft')).toBeInTheDocument();
    expect(within(draft).getByText('Not visible to employees.')).toBeInTheDocument();

    const published = screen.getByTestId('menu-day-2027-03-02');
    expect(within(published).getByText('Published')).toBeInTheDocument();
    expect(within(published).getByText('Employees can see and select this menu.')).toBeInTheDocument();

    const archived = screen.getByTestId('menu-day-2027-03-03');
    expect(within(archived).getByText('Archived')).toBeInTheDocument();
  });

  it('shows both options and the components with readable labels', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminMenuPage />);

    const card = await screen.findByTestId('menu-day-2027-03-01');
    expect(within(card).getByText('Option 1')).toBeInTheDocument();
    expect(within(card).getByText('Test Main Alpha')).toBeInTheDocument();
    expect(within(card).getByText('Option 2')).toBeInTheDocument();
    expect(within(card).getByText('Test Main Beta')).toBeInTheDocument();
    // "salad" is rendered as a label, not as the raw internal value.
    expect(within(card).getByText('Salad')).toBeInTheDocument();
    expect(within(card).getByText('Test Salad')).toBeInTheDocument();
  });

  it('never offers a third option', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminMenuPage />);
    await screen.findByTestId('menu-day-2027-03-01');

    expect(screen.queryByText('Option 3')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/No Preference/i);
  });
});

// ============================================================================
// CREATE
// ============================================================================

describe('Admin menu - create', () => {
  it('creates a menu day as a draft, never sending a status', async () => {
    const fetchMock = stubFetch(routes({ [CREATE]: ok(menuDay({ id: 9, meal_date: '2027-03-09' })) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    await screen.findByTestId('current-month');

    await user.type(screen.getByLabelText('Date'), '2027-03-09');
    await user.click(screen.getByRole('button', { name: 'Add as draft' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/api/menu' && (i as RequestInit)?.method === 'POST')).toBe(true)
    );

    const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/menu' && (i as RequestInit)?.method === 'POST')!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ meal_date: '2027-03-09' });
    expect(body.status).toBeUndefined();
  });

  it('refuses to submit without a date', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    await screen.findByTestId('current-month');
    await user.click(screen.getByRole('button', { name: 'Add as draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a date first.');
    expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === '/api/menu' && (i as RequestInit)?.method === 'POST')).toHaveLength(0);
  });

  it('surfaces a server rejection', async () => {
    stubFetch(routes({ [CREATE]: fail(400, 'Invalid or missing meal_date') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    await screen.findByTestId('current-month');
    await user.type(screen.getByLabelText('Date'), '2027-03-09');
    await user.click(screen.getByRole('button', { name: 'Add as draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid or missing meal_date');
  });
});

// ============================================================================
// EDIT
// ============================================================================

describe('Admin menu - edit', () => {
  it('saves both options and states that saving never publishes', async () => {
    const fetchMock = stubFetch(routes({ 'POST /api/menu/1/options': ok({}) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');
    await user.click(within(card).getByRole('button', { name: 'Edit' }));

    expect(
      screen.getByText(/never publishes, and it never unpublishes a menu/i)
    ).toBeInTheDocument();

    const option1 = screen.getByLabelText('Option 1');
    await user.clear(option1);
    await user.type(option1, 'Corrected Alpha');
    await user.click(screen.getByRole('button', { name: 'Save draft changes' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/menu/1/options')).toBe(true)
    );

    const bodies = fetchMock.mock.calls
      .filter(([u]) => String(u) === '/api/menu/1/options')
      .map(([, i]) => JSON.parse((i as RequestInit).body as string));

    expect(bodies[0]).toMatchObject({ option_number: 1, name: 'Corrected Alpha' });
    expect(bodies[1]).toMatchObject({ option_number: 2, name: 'Test Main Beta' });
    // No status is ever sent from the edit form.
    for (const body of bodies) expect(body.status).toBeUndefined();
  });

  it('refuses to save when an option is blank', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');
    await user.click(within(card).getByRole('button', { name: 'Edit' }));

    await user.clear(screen.getByLabelText('Option 2'));
    await user.click(screen.getByRole('button', { name: 'Save draft changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Both options need a name.');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/options'))).toHaveLength(0);
  });

  it('offers only the component types the schema allows', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');
    await user.click(within(card).getByRole('button', { name: 'Edit' }));

    const select = screen.getByLabelText('Component') as unknown as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['salad', 'soup', 'bread', 'condiment', 'beverage', 'dessert', 'other']);
    // No invented taxonomy.
    expect(values).not.toContain('side');
    expect(values).not.toContain('main');
  });

  it('edits an existing component in place, sending its id', async () => {
    const fetchMock = stubFetch(
      routes({ 'POST /api/menu/1/options': ok({}), 'POST /api/menu/1/components': ok({}) })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');
    await user.click(within(card).getByRole('button', { name: 'Edit' }));

    await user.type(screen.getByLabelText('Component name'), 'New Salad');
    await user.click(screen.getByRole('button', { name: 'Save draft changes' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/menu/1/components')).toBe(true)
    );

    const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/menu/1/components')!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({
      component_type: 'salad',
      name: 'New Salad',
      component_id: 5,
    });
  });

  it('cancelling changes nothing', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByLabelText('Option 1')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/options'))).toHaveLength(0);
  });
});

// ============================================================================
// PUBLISH
// ============================================================================

describe('Admin menu - publish', () => {
  it('publishing is a separate, confirmed action', async () => {
    const fetchMock = stubFetch(routes({ 'PUT /api/menu/1/publish': ok(menuDay({ status: 'published' })) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');
    await user.click(within(card).getByRole('button', { name: 'Publish' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Publish the menu for 2027-03-01?');
    expect(dialog).toHaveTextContent(/eligible employees can see this menu/i);
    expect(dialog).toHaveTextContent(/Existing selections are never changed/i);
    // Nothing sent until confirmed.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/publish'))).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Publish menu' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/menu/1/publish')).toHaveLength(1)
    );
  });

  it('cancelling the publish confirmation sends nothing', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');
    await user.click(within(card).getByRole('button', { name: 'Publish' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/publish'))).toHaveLength(0);
  });

  it('an INCOMPLETE menu cannot be published from the UI', async () => {
    const fetchMock = stubFetch({
      [ME]: ok(ADMIN_USER),
      [RANGE]: month([menuDay({ options: [option(1, 'Only One')] })]),
    });
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');

    expect(within(card).getByText(/needs both options before it can be published/i)).toBeInTheDocument();
    const publish = within(card).getByRole('button', { name: 'Publish' });
    expect(publish).toBeDisabled();

    await user.click(publish);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/publish'))).toHaveLength(0);
  });

  it('a published menu offers no Publish button', async () => {
    stubFetch({ [ME]: ok(ADMIN_USER), [RANGE]: month([menuDay({ status: 'published' })]) });
    renderWithProviders(<AdminMenuPage />);

    const card = await screen.findByTestId('menu-day-2027-03-01');
    expect(within(card).queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('surfaces a server refusal to publish', async () => {
    stubFetch(
      routes({ 'PUT /api/menu/1/publish': fail(400, 'This menu cannot be published yet: Option 2 is missing.') })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');
    await user.click(within(card).getByRole('button', { name: 'Publish' }));
    await user.click(await screen.findByRole('button', { name: 'Publish menu' }));

    expect(
      await screen.findByText('This menu cannot be published yet: Option 2 is missing.')
    ).toBeInTheDocument();
  });

  it('archiving is confirmed and says selections are kept', async () => {
    const fetchMock = stubFetch(routes({ 'PUT /api/menu/1/archive': ok(menuDay({ status: 'archived' })) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');
    await user.click(within(card).getByRole('button', { name: 'Archive' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/Selections already made are kept/i);

    await user.click(screen.getByRole('button', { name: 'Archive menu' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/menu/1/archive')).toHaveLength(1)
    );
  });
});

// ============================================================================
// SECRETS
// ============================================================================

describe('Admin menu - handles no credentials', () => {
  it('offers no password field and stores nothing in the browser', async () => {
    const fetchMock = stubFetch(routes({ 'POST /api/menu/1/options': ok({}) }));
    const user = userEvent.setup();
    localStorage.clear();
    sessionStorage.clear();

    renderWithProviders(<AdminMenuPage />);
    const card = await screen.findByTestId('menu-day-2027-03-01');
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save draft changes' }));

    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    for (const [url, init] of fetchMock.mock.calls) {
      const body = (init as RequestInit | undefined)?.body;
      const serialised = typeof body === 'string' ? body : '';
      expect(`${String(url)} ${serialised}`).not.toMatch(/password|token|secret/i);
    }
  });

  it('computes no eligibility and derives no business date itself', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminMenuPage />);
    await screen.findByTestId('menu-day-2027-03-01');

    // The only date shown as "today" is the one the server sent.
    expect(screen.getByText('2027-03-07')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/eligible|ROSTER_MISSING/i);
  });
});
