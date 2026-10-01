// @vitest-environment jsdom
/**
 * Frontend tests - employee portal UI states.
 *
 * These render the real components through the real hooks, router and API
 * client, stubbing only `fetch`. Backend behaviour is covered separately by the
 * Hono integration suites; these assert what the employee actually sees.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { App } from '../../src/frontend/App.js';
import { LoginPage } from '../../src/frontend/pages/LoginPage.js';
import { EmployeeDashboard } from '../../src/frontend/pages/EmployeeDashboard.js';
import { SelectionHistoryPage } from '../../src/frontend/pages/SelectionHistoryPage.js';
import { ProfilePage } from '../../src/frontend/pages/ProfilePage.js';
import {
  renderWithProviders,
  stubFetch,
  todayPayload,
  SESSION_USER,
  ok,
  fail,
} from './helpers.js';

const ME = '/api/auth/me';
const TODAY = '/api/me/today';
const LOGIN = '/api/auth/login';
const HISTORY = '/api/me/selections/history';
const SELECT = '/api/selections/me';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Login', () => {
  it('1. a successful login lands the employee on the dashboard', async () => {
    const user = userEvent.setup();
    let signedIn = false;

    stubFetch({
      [LOGIN]: ok({ employee: SESSION_USER }),
      get [ME]() {
        return signedIn ? ok(SESSION_USER) : fail(401, 'Not authenticated');
      },
      [TODAY]: ok(todayPayload()),
    });

    renderWithProviders(<App />, { route: '/login' });

    await screen.findByRole('heading', { name: 'CanteenHub' });
    await user.type(screen.getByLabelText('ID'), 'TEST001');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    signedIn = true;
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Portal Tester' })).toBeInTheDocument();
  });

  it('2. a failed login shows an error and does not navigate', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: fail(401, 'Not authenticated'),
      [LOGIN]: fail(401, 'Invalid credentials'),
    });

    renderWithProviders(<LoginPage />);

    await user.type(await screen.findByLabelText('ID'), 'TEST001');
    await user.type(screen.getByLabelText('Password'), 'wrong-password-here');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid ID or password.');
  });

  it('validates empty fields before calling the API', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch({ [ME]: fail(401, 'Not authenticated') });

    renderWithProviders(<LoginPage />);
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your ID and password.');
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/login'))).toBe(false);
  });

  it('shows a loading state while signing in', async () => {
    const user = userEvent.setup();
    stubFetch(
      { [ME]: fail(401, 'Not authenticated'), [LOGIN]: ok({ employee: SESSION_USER }) },
      { delayPaths: [LOGIN] }
    );

    renderWithProviders(<LoginPage />);
    await user.type(await screen.findByLabelText('ID'), 'TEST001');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('button', { name: 'Signing in…' })).toBeInTheDocument();
  });

  it('never writes credentials to localStorage', async () => {
    const user = userEvent.setup();
    stubFetch({ [ME]: fail(401, 'Not authenticated'), [LOGIN]: ok({ employee: SESSION_USER }) });

    renderWithProviders(<LoginPage />);
    await user.type(await screen.findByLabelText('ID'), 'TEST001');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(localStorage.length).toBe(0));
    expect(JSON.stringify(localStorage)).not.toContain('correct-horse-battery');
    expect(JSON.stringify(sessionStorage)).not.toContain('correct-horse-battery');
  });
});

describe('Route protection', () => {
  it('3. an unauthenticated visitor to the dashboard is sent to login', async () => {
    stubFetch({ [ME]: fail(401, 'Not authenticated') });

    renderWithProviders(<App />, { route: '/' });

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Portal Tester' })).not.toBeInTheDocument();
  });

  it('3. history and profile are protected too', async () => {
    stubFetch({ [ME]: fail(401, 'Not authenticated') });

    renderWithProviders(<App />, { route: '/history' });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('an authenticated employee reaches the dashboard, and the session survives a remount', async () => {
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });

    const first = renderWithProviders(<App />, { route: '/' });
    expect(await screen.findByRole('heading', { name: 'Portal Tester' })).toBeInTheDocument();

    // Remounting with a fresh cache is what a page refresh does: the session is
    // re-established from the cookie, not from anything the app stored.
    first.unmount();
    renderWithProviders(<App />, { route: '/' });
    expect(await screen.findByRole('heading', { name: 'Portal Tester' })).toBeInTheDocument();
  });

  it('4. logout clears the session and returns to login', async () => {
    const user = userEvent.setup();
    let signedIn = true;

    stubFetch({
      get [ME]() {
        return signedIn ? ok(SESSION_USER) : fail(401, 'Not authenticated');
      },
      [TODAY]: ok(todayPayload()),
      '/api/auth/logout': ok(null),
    });

    renderWithProviders(<App />, { route: '/' });
    await screen.findByRole('heading', { name: 'Portal Tester' });

    signedIn = false;
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('Dashboard — identity, date and eligibility', () => {
  it('5. shows the employee identity', async () => {
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });
    renderWithProviders(<EmployeeDashboard />);

    expect(await screen.findByRole('heading', { name: 'Portal Tester' })).toBeInTheDocument();
    expect(screen.getByText(/TEST001/)).toBeInTheDocument();
    expect(screen.getByText(/Mining/)).toBeInTheDocument();
  });

  it('renders the SERVER business date, not a browser-derived one', async () => {
    // The browser clock is deliberately a different day from the server's.
    vi.setSystemTime(new Date('2027-06-15T12:00:00Z'));
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload({ businessDate: '2027-03-07' })) });

    renderWithProviders(<EmployeeDashboard />);

    // The server's own business date, shown as "today" - the meal date beside
    // it is also the server's. Neither is derived from the browser clock.
    expect(await screen.findByText(/Today is Sunday, 7 March 2027/)).toBeInTheDocument();
    expect(screen.queryByText(/June/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('7. an eligible employee sees the eligible state', async () => {
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });
    renderWithProviders(<EmployeeDashboard />);

    expect(await screen.findByText('Eligible for lunch')).toBeInTheDocument();
  });

  it.each([
    ['REGULAR_NON_WORKING_DAY', 'This is not one of your working days, so no meal is provided.'],
    ['SHIFT_OFF', 'You are rostered off, so no meal is provided.'],
    ['ROSTER_MISSING', 'Your shift roster for this date has not been published yet.'],
    ['AMMAN_HQ_NO_MEAL', 'Amman HQ employees do not receive a company meal.'],
    ['HOLIDAY', 'This is a company holiday, so no meal is served.'],
    ['EMPLOYEE_INACTIVE', 'Your account is not active. Please contact the canteen administrator.'],
  ])('8. reason %s renders its human-readable explanation', async (reason, expected) => {
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(
        todayPayload({
          eligibility: {
            eligible: false,
            reason: reason as never,
            rosterType: 'regular',
            nextEligibleDate: null,
          },
          canSelect: false,
        })
      ),
    });

    renderWithProviders(<EmployeeDashboard />);

    expect(await screen.findByText('Not eligible for lunch')).toBeInTheDocument();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('9. a next eligible date is displayed when the server provides one', async () => {
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(
        todayPayload({
          eligibility: {
            eligible: false,
            reason: 'REGULAR_NON_WORKING_DAY',
            rosterType: 'regular',
            nextEligibleDate: '2027-03-08',
          },
          canSelect: false,
        })
      ),
    });

    renderWithProviders(<EmployeeDashboard />);
    expect(await screen.findByText(/Monday, 8 March 2027/)).toBeInTheDocument();
  });

  it('10. a null next eligible date shows the explicit message, not a guess', async () => {
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(
        todayPayload({
          eligibility: {
            eligible: false,
            reason: 'ROSTER_MISSING',
            rosterType: 'shift',
            nextEligibleDate: null,
          },
          canSelect: false,
        })
      ),
    });

    renderWithProviders(<EmployeeDashboard />);
    expect(
      await screen.findByText('No upcoming eligible meal is currently scheduled.')
    ).toBeInTheDocument();
  });

  it('an ineligible employee is offered no meal choices at all', async () => {
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(
        todayPayload({
          eligibility: {
            eligible: false,
            reason: 'AMMAN_HQ_NO_MEAL',
            rosterType: 'amman_hq',
            nextEligibleDate: null,
          },
          canSelect: false,
        })
      ),
    });

    renderWithProviders(<EmployeeDashboard />);
    await screen.findByText('Not eligible for lunch');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit my choice' })).not.toBeInTheDocument();
  });
});

describe('Dashboard — menu', () => {
  it('11. a published menu shows both options and the common components', async () => {
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });
    renderWithProviders(<EmployeeDashboard />);

    // The dish name appears twice by design: once in the menu, once on the
    // choice card, so the employee never has to scroll up to see what they are
    // choosing between.
    expect((await screen.findAllByText('Test Dish Alpha')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Test Dish Beta').length).toBeGreaterThan(0);
    expect(screen.getByText('Test Beverage')).toBeInTheDocument();
    expect(
      screen.getByText('These are served with either option and are not a separate choice.')
    ).toBeInTheDocument();
  });

  it('12 & 13. no published menu shows the empty state and hides the choices', async () => {
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(todayPayload({ menu: null, canSelect: false })),
    });

    renderWithProviders(<EmployeeDashboard />);

    expect(await screen.findByText('Today’s lunch menu is not available.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit my choice' })).not.toBeInTheDocument();
  });
});

describe('Dashboard — selection', () => {
  /** Pick a canteen, which every submission requires. */
  const chooseCanteen = async (
    user: ReturnType<typeof userEvent.setup>,
    value = 'amco_canteen'
  ) => {
    await user.selectOptions(await screen.findByLabelText('Collect from'), value);
  };

  const savedSelection = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    meal_date: '2027-03-07',
    choice: 'option_1' as const,
    pickup_location: 'amco_canteen' as const,
    source: 'employee' as const,
    selected_at: '',
    updated_at: '',
    ...overrides,
  });

  const option2Box = () => screen.findByRole('checkbox', { name: /I want Option 2/ });

  /** The body of the one selection request the screen sent. */
  const sentSelection = (spy: ReturnType<typeof stubFetch>) => {
    const call = spy.mock.calls.find(([url]) => String(url).includes(SELECT));
    return call ? JSON.parse(String(call[1]?.body)) : null;
  };

  // ==========================================================================
  // Option 1 is the default; Option 2 is a checkbox
  // ==========================================================================

  it('14. states the default plainly: Option 1 unless Option 2 is checked', async () => {
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });
    renderWithProviders(<EmployeeDashboard />);

    const rule = await screen.findByRole('note');
    expect(rule).toHaveTextContent('The default meal is Option 1 (Test Dish Alpha).');
    expect(rule).toHaveTextContent('If you do not check Option 2, you will be served Option 1.');
  });

  it('15. offers Option 2 as a single, unchecked checkbox - and no radio buttons', async () => {
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });
    renderWithProviders(<EmployeeDashboard />);

    const box = await option2Box();
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleName(/Test Dish Beta/);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('16. checking Option 2 and submitting sends option_2 with the canteen', async () => {
    const user = userEvent.setup();
    const spy = stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(todayPayload()),
      [SELECT]: ok({ id: 1 }),
    });
    renderWithProviders(<EmployeeDashboard />);

    await user.click(await option2Box());
    await chooseCanteen(user, 'omco_canteen');
    await user.click(screen.getByRole('button', { name: 'Submit my choice' }));

    expect(await screen.findByText('Submitted. You are down for Option 2 at OMCO Canteen.')).toBeInTheDocument();
    expect(sentSelection(spy)).toMatchObject({ choice: 'option_2', pickup_location: 'omco_canteen' });
  });

  it('checking the box sends nothing until Submit is pressed, and says so', async () => {
    const user = userEvent.setup();
    const spy = stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(todayPayload()),
      [SELECT]: ok({ id: 1 }),
    });
    renderWithProviders(<EmployeeDashboard />);

    await user.click(await option2Box());
    await chooseCanteen(user);

    expect(await option2Box()).toBeChecked();
    expect(screen.getByText(/Not submitted yet\. Press/)).toBeInTheDocument();
    expect(sentSelection(spy)).toBeNull();
  });

  it('17. a saved Option 2 is shown checked, with nothing to submit', async () => {
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(todayPayload({ selection: savedSelection({ choice: 'option_2' }) })),
    });
    renderWithProviders(<EmployeeDashboard />);

    expect(await option2Box()).toBeChecked();
    expect(screen.getByRole('button', { name: 'Submit my choice' })).toBeDisabled();
  });

  it('18. unchecking a saved Option 2 goes back to Option 1, and is reported', async () => {
    const user = userEvent.setup();
    const spy = stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(todayPayload({ selection: savedSelection({ choice: 'option_2' }) })),
      [SELECT]: ok({ id: 1 }),
    });
    renderWithProviders(<EmployeeDashboard />);

    await user.click(await option2Box());
    await user.click(screen.getByRole('button', { name: 'Submit my choice' }));

    expect(await screen.findByText('Submitted. You are down for Option 1 at AMCO Canteen.')).toBeInTheDocument();
    expect(sentSelection(spy)).toMatchObject({ choice: 'option_1' });
  });

  it('21. ticking and unticking back to what is saved leaves nothing to submit', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(todayPayload({ selection: savedSelection() })),
    });
    renderWithProviders(<EmployeeDashboard />);

    await user.click(await option2Box());
    await user.click(await option2Box());

    expect(screen.getByRole('button', { name: 'Submit my choice' })).toBeDisabled();
    expect(screen.queryByText(/Not submitted yet\. Press/)).not.toBeInTheDocument();
  });

  it('changing only the canteen is itself a submittable change', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(todayPayload({ selection: savedSelection() })),
      [SELECT]: ok({ id: 1 }),
    });
    renderWithProviders(<EmployeeDashboard />);
    await chooseCanteen(user, 'omco_canteen');

    const submit = screen.getByRole('button', { name: 'Submit my choice' });
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText('Submitted. You are down for Option 1 at OMCO Canteen.')).toBeInTheDocument();
  });

  it('19. a cutoff rejection from the server is shown verbatim', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(todayPayload()),
      [SELECT]: fail(400, 'Selection cutoff time has passed'),
    });
    renderWithProviders(<EmployeeDashboard />);

    await user.click(await option2Box());
    await chooseCanteen(user);
    await user.click(screen.getByRole('button', { name: 'Submit my choice' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Selection cutoff time has passed');
  });

  it('19. when the cutoff has already passed the checkbox is disabled', async () => {
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(todayPayload({ cutoffPassed: true, canSelect: false })),
    });
    renderWithProviders(<EmployeeDashboard />);

    expect(await option2Box()).toBeDisabled();
    expect(
      screen.getByText(
        'The selection deadline for this date has passed, so your choice can no longer be changed.'
      )
    ).toBeInTheDocument();
  });

  it('20. an eligibility rejection from the server is shown verbatim', async () => {
    const user = userEvent.setup();
    stubFetch({
      [ME]: ok(SESSION_USER),
      [TODAY]: ok(todayPayload()),
      [SELECT]: fail(403, 'Not eligible: SHIFT_OFF'),
    });
    renderWithProviders(<EmployeeDashboard />);

    await chooseCanteen(user);
    await user.click(screen.getByRole('button', { name: 'Submit my choice' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not eligible: SHIFT_OFF');
  });

  // ==========================================================================
  // WHERE the meal is collected - required to submit
  // ==========================================================================

  describe('the canteen must be chosen', () => {
    it('starts with nothing chosen, and will not submit until one is', async () => {
      const user = userEvent.setup();
      const spy = stubFetch({
        [ME]: ok(SESSION_USER),
        [TODAY]: ok(todayPayload()),
        [SELECT]: ok({ id: 1 }),
      });
      renderWithProviders(<EmployeeDashboard />);

      // NOT pre-filled from the employee's usual canteen: the whole point is
      // that somebody looks at it.
      expect(await screen.findByLabelText('Collect from')).toHaveValue('');
      expect(screen.getByRole('button', { name: 'Submit my choice' })).toBeDisabled();
      expect(screen.getByText(/Choose where you will collect this meal/i)).toBeInTheDocument();

      await user.click(await option2Box());
      expect(screen.getByRole('button', { name: 'Submit my choice' })).toBeDisabled();
      expect(sentSelection(spy)).toBeNull();

      await chooseCanteen(user, 'whc_canteen');
      expect(screen.getByRole('button', { name: 'Submit my choice' })).toBeEnabled();
    });
  });

  // ==========================================================================
  // The healthy meal - reserved by submitting
  // ==========================================================================

  describe('an employee on the healthy meal', () => {
    const healthyPayload = (overrides: Record<string, unknown> = {}) =>
      todayPayload({
        choiceLocked: true,
        employee: { ...todayPayload().employee, meal_preference: 'healthy' },
        ...overrides,
      });

    it('is offered no options - not even the Option 2 checkbox', async () => {
      stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(healthyPayload()) });
      renderWithProviders(<EmployeeDashboard />);

      expect(await screen.findByText('Healthy meal')).toBeInTheDocument();
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      expect(screen.queryAllByRole('radio')).toHaveLength(0);
    });

    it('is told to submit to reserve it, or be served Option 1', async () => {
      stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(healthyPayload()) });
      renderWithProviders(<EmployeeDashboard />);

      const rule = await screen.findByRole('note');
      expect(rule).toHaveTextContent(/To reserve it for this date, choose where you will collect it and press Submit/);
      expect(rule).toHaveTextContent('If you do not submit, you will be served Option 1 (Test Dish Alpha) instead.');
      expect(screen.getByText('Not reserved yet.')).toBeInTheDocument();
      // The ordinary employee's statement does not apply to them.
      expect(screen.queryByText(/If you do not check Option 2/)).not.toBeInTheDocument();
    });

    it('reserves it by choosing a canteen and pressing Submit', async () => {
      const user = userEvent.setup();
      const spy = stubFetch({
        [ME]: ok(SESSION_USER),
        [TODAY]: ok(healthyPayload()),
        [SELECT]: ok({ id: 1 }),
      });
      renderWithProviders(<EmployeeDashboard />);

      await chooseCanteen(user, 'whc_canteen');
      await user.click(screen.getByRole('button', { name: 'Submit my choice' }));

      expect(await screen.findByText(/Submitted\./)).toBeInTheDocument();
      expect(sentSelection(spy)).toMatchObject({ choice: 'healthy', pickup_location: 'whc_canteen' });
    });

    it('shows the day as reserved once they have submitted', async () => {
      stubFetch({
        [ME]: ok(SESSION_USER),
        [TODAY]: ok(healthyPayload({ selection: savedSelection({ choice: 'healthy' }) })),
      });
      renderWithProviders(<EmployeeDashboard />);

      expect(await screen.findByText('Reserved for this date.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Submit my choice' })).toBeDisabled();
    });
  });

  // ==========================================================================
  // Lunch is chosen a day ahead
  // ==========================================================================

  describe('the day being ordered', () => {
    it('names the meal date, and today separately', async () => {
      stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });
      renderWithProviders(<EmployeeDashboard />);

      // mealDate is 2027-03-07; businessDate is the day before.
      expect(await screen.findByText(/Lunch for Sunday, 7 March 2027/)).toBeInTheDocument();
      expect(screen.getByText(/Today is Saturday, 6 March 2027/)).toBeInTheDocument();
    });

    it('never claims the meal is today', async () => {
      stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });
      renderWithProviders(<EmployeeDashboard />);
      await screen.findByText(/Lunch for Sunday, 7 March 2027/);

      expect(screen.queryByText(/eligible for lunch today/i)).not.toBeInTheDocument();
    });
  });

  it('shows a loading state, then the content', async () => {
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });
    renderWithProviders(<EmployeeDashboard />);

    expect(screen.getByRole('status')).toHaveTextContent(/Loading/);
    expect(await screen.findByText('Eligible for lunch')).toBeInTheDocument();
  });

  it('shows an error state when the dashboard request fails', async () => {
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: fail(500, 'Internal Server Error') });
    renderWithProviders(<EmployeeDashboard />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Internal Server Error');
  });
});

describe('History page', () => {
  it('22. renders the employee’s own history', async () => {
    stubFetch({
      [ME]: ok(SESSION_USER),
      [HISTORY]: ok({
        entries: [
          {
            id: 2, meal_date: '2027-03-07', previous_choice: 'option_1',
            new_choice: 'option_2', changed_at: '2027-03-07T06:00:00Z', source: 'employee',
          },
          {
            id: 1, meal_date: '2027-03-06', previous_choice: null,
            new_choice: 'option_1', changed_at: '2027-03-06T06:00:00Z', source: 'employee',
          },
        ],
        total: 2, limit: 30, offset: 0,
      }),
    });

    renderWithProviders(<SelectionHistoryPage />);

    expect(await screen.findByText('07 Mar 2027')).toBeInTheDocument();
    expect(screen.getByText('Changed from Option 1 · set by You')).toBeInTheDocument();
    expect(screen.getByText('First selection · set by You')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 2.')).toBeInTheDocument();
  });

  it('shows an admin override as set by the administrator', async () => {
    stubFetch({
      [ME]: ok(SESSION_USER),
      [HISTORY]: ok({
        entries: [
          {
            id: 3, meal_date: '2027-03-07', previous_choice: 'option_1',
            new_choice: 'option_2', changed_at: '2027-03-07T06:00:00Z', source: 'admin_override',
          },
        ],
        total: 1, limit: 30, offset: 0,
      }),
    });

    renderWithProviders(<SelectionHistoryPage />);
    expect(await screen.findByText(/set by Administrator/)).toBeInTheDocument();
  });

  it('shows an empty state when there is no history', async () => {
    stubFetch({
      [ME]: ok(SESSION_USER),
      [HISTORY]: ok({ entries: [], total: 0, limit: 30, offset: 0 }),
    });

    renderWithProviders(<SelectionHistoryPage />);
    expect(
      await screen.findByText('You have not made any lunch selections yet.')
    ).toBeInTheDocument();
  });
});

describe('Profile page', () => {
  it('shows safe fields only', async () => {
    stubFetch({ [ME]: ok(SESSION_USER), [TODAY]: ok(todayPayload()) });
    const { container } = renderWithProviders(<ProfilePage />);

    expect(await screen.findByText('Portal Tester')).toBeInTheDocument();
    expect(screen.getByText('TEST001')).toBeInTheDocument();
    expect(screen.getByText('Mining')).toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('Regular')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();

    // The page copy legitimately mentions asking an admin to change a password;
    // what must never appear is credential material or internal columns.
    const rendered = container.textContent ?? '';
    expect(rendered).not.toContain('password_hash');
    expect(rendered).not.toContain('pbkdf2');
    expect(rendered).not.toContain('role_id');
    expect(rendered).not.toContain('$');
  });
});
