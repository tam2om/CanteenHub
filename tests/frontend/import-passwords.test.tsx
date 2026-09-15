// @vitest-environment jsdom
/**
 * Frontend tests - applying passwords from an employee workbook.
 *
 * This step sets the credential of every person in the company, and until now
 * it had no test at all. It is driven here the way an administrator drives it:
 * a REAL .xlsx built by the project's own writer, handed to the real component
 * as a File, with only `fetch` stubbed - so the workbook reading, the paging
 * and the per-employee requests are all genuinely exercised.
 *
 * Every value is synthetic. The passwords below are fixture strings and appear
 * nowhere else.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ImportPasswordStep } from '../../src/frontend/pages/admin/ImportPasswordStep.js';
import { buildXlsx } from '../../src/worker/lib/xlsxWrite.js';
import { renderWithProviders, ok, fail } from './helpers.js';

const EMPLOYEES = '/api/admin/employees';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A workbook shaped exactly like the downloadable employee template. */
function workbook(
  rows: Array<Array<string>>,
  { sheetName = 'All Employees', headers = ['ID', 'Name', 'Department', 'Section', 'Roster', 'Password'] } = {}
): File {
  const bytes = buildXlsx([{ name: sheetName, rows: [headers, ...rows] }]);
  return new File([bytes as unknown as BlobPart], 'employees.xlsx');
}

const ROW_A = ['TEST100', 'Alpha Person', 'Mining', 'Operations', 'Regular', 'fixture-pass-a'];
const ROW_B = ['TEST101', 'Beta Person', 'Processing', 'Shifts', 'Shift', 'fixture-pass-b'];

/** The admin employee list, as the API returns one page of it. */
const listPage = (employees: Array<{ id: number; amco_id: string }>, total = employees.length) =>
  ok({
    employees: employees.map((e) => ({
      ...e,
      full_name: 'X',
      department: null,
      section: null,
      roster_type: 'regular',
      is_active: 1,
      role_id: 1,
      default_location: 'amco_canteen',
    })),
    total,
  });

describe('Applying passwords from an employee workbook', () => {
  it('sets one password per employee named in the workbook', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubPasswordRoutes([
      { id: 11, amco_id: 'TEST100' },
      { id: 12, amco_id: 'TEST101' },
    ]);

    renderWithProviders(<ImportPasswordStep file={workbook([ROW_A, ROW_B])} />);
    await user.click(screen.getByRole('button', { name: /Set passwords/ }));

    expect(await screen.findByText(/Finished: 2 of 2/)).toBeInTheDocument();

    const puts = passwordPuts(fetchSpy);
    expect(puts).toEqual([
      { url: `${EMPLOYEES}/11/password`, password: 'fixture-pass-a' },
      { url: `${EMPLOYEES}/12/password`, password: 'fixture-pass-b' },
    ]);
  });

  it('matches an ID whose case differs from the stored employee', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubPasswordRoutes([{ id: 11, amco_id: 'TEST100' }]);

    renderWithProviders(
      <ImportPasswordStep
        file={workbook([['test100', 'Alpha Person', 'Mining', 'Operations', 'Regular', 'fixture-pass-a']])}
      />
    );
    await user.click(screen.getByRole('button', { name: /Set passwords/ }));

    expect(await screen.findByText(/Finished: 1 of 1/)).toBeInTheDocument();
    expect(passwordPuts(fetchSpy)).toHaveLength(1);
  });

  it('reads employees BEYOND the first page, which the server caps at 100', async () => {
    const user = userEvent.setup();
    // 150 employees: the workbook names one from the second page only.
    const all = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, amco_id: `BULK${i}` }));
    const fetchSpy = stubPagedRoutes(all);

    renderWithProviders(
      <ImportPasswordStep
        file={workbook([['BULK140', 'Late Person', '', '', 'Regular', 'fixture-pass-c']])}
      />
    );
    await user.click(screen.getByRole('button', { name: /Set passwords/ }));

    expect(await screen.findByText(/Finished: 1 of 1/)).toBeInTheDocument();
    expect(passwordPuts(fetchSpy)).toEqual([
      { url: `${EMPLOYEES}/141/password`, password: 'fixture-pass-c' },
    ]);
  });

  it('reports the employees it could not set, naming each one', async () => {
    const user = userEvent.setup();
    stubPasswordRoutes([{ id: 11, amco_id: 'TEST100' }], {
      [`PUT ${EMPLOYEES}/11/password`]: fail(400, 'Password must be at least 5 characters'),
    });

    renderWithProviders(<ImportPasswordStep file={workbook([ROW_A, ROW_B])} />);
    await user.click(screen.getByRole('button', { name: /Set passwords/ }));

    await waitFor(() => expect(screen.getByText(/Finished: 0 of 2/)).toBeInTheDocument());
    expect(screen.getByText(/TEST100: Password must be at least 5 characters/)).toBeInTheDocument();
    // The employee the list never returned is named too, not silently skipped.
    expect(screen.getByText(/TEST101: No employee with this ID exists/)).toBeInTheDocument();
  });

  /**
   * The step used to exist only while the just-imported File was still in the
   * import page's memory. An administrator who committed the import and then
   * looked away had no way to apply the passwords at all - and re-importing
   * does not help, because an import never sets one.
   */
  it('works on a workbook chosen here, with no import in progress', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubPasswordRoutes([{ id: 11, amco_id: 'TEST100' }]);

    renderWithProviders(<ImportPasswordStep />);

    // Nothing to apply until a workbook is chosen.
    expect(screen.getByRole('button', { name: /Set passwords/ })).toBeDisabled();

    await user.upload(screen.getByLabelText(/Workbook with a Password column/), workbook([ROW_A]));
    await user.click(screen.getByRole('button', { name: /Set passwords/ }));

    expect(await screen.findByText(/Finished: 1 of 1/)).toBeInTheDocument();
    expect(passwordPuts(fetchSpy)).toEqual([
      { url: `${EMPLOYEES}/11/password`, password: 'fixture-pass-a' },
    ]);
  });

  it('says plainly that importing a workbook does not set passwords', () => {
    stubPasswordRoutes([]);
    renderWithProviders(<ImportPasswordStep />);
    expect(screen.getByText(/never sets a password/i)).toBeInTheDocument();
  });

  /**
   * A real run of 253 employees set 143 and then Cloudflare answered 503 for
   * the remaining 110: three requests in flight, each costing the Worker a
   * deliberate ~57 ms of hashing, was more than the platform would carry. A
   * temporary refusal must not be reported to an administrator as a failed
   * password.
   */
  it('rides out a 503 and sets the password anyway', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const fetchSpy = stubFetchExact({
      [`${EMPLOYEES}?page=1&page_size=100`]: listPage([{ id: 11, amco_id: 'TEST100' }]),
      [`PUT ${EMPLOYEES}/11/password`]: {
        get status() {
          attempts += 1;
          return attempts === 1 ? 503 : 200;
        },
        body: { employee_id: 11, amco_id: 'TEST100', password_set: true, sessionsRevoked: 0 },
      },
    });

    renderWithProviders(<ImportPasswordStep file={workbook([ROW_A])} />);
    await user.click(screen.getByRole('button', { name: /Set passwords/ }));

    expect(await screen.findByText(/Finished: 1 of 1/, {}, { timeout: 10000 })).toBeInTheDocument();
    expect(passwordPuts(fetchSpy)).toHaveLength(2); // refused once, then accepted
    expect(screen.queryByText(/TEST100:/)).not.toBeInTheDocument();
  }, 15000);

  it('does NOT retry a refusal the server actually decided', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetchExact({
      [`${EMPLOYEES}?page=1&page_size=100`]: listPage([{ id: 11, amco_id: 'TEST100' }]),
      [`PUT ${EMPLOYEES}/11/password`]: fail(400, 'Password must be at least 5 characters'),
    });

    renderWithProviders(<ImportPasswordStep file={workbook([ROW_A])} />);
    await user.click(screen.getByRole('button', { name: /Set passwords/ }));

    await waitFor(() => expect(screen.getByText(/Finished: 0 of 1/)).toBeInTheDocument());
    // One attempt, not four: repeating a 400 only repeats the same answer.
    expect(passwordPuts(fetchSpy)).toHaveLength(1);
    expect(screen.getByText(/TEST100: Password must be at least 5 characters/)).toBeInTheDocument();
  });

  it('sends one request at a time, never overlapping', async () => {
    const user = userEvent.setup();
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PUT') {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
        }
        if (url.includes(`${EMPLOYEES}?`)) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                employees: [
                  { id: 11, amco_id: 'TEST100', full_name: 'X', roster_type: 'regular', is_active: 1 },
                  { id: 12, amco_id: 'TEST101', full_name: 'X', roster_type: 'regular', is_active: 1 },
                ],
                total: 2,
              },
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ success: false, error: 'Not Found' }), { status: 404 });
      })
    );

    renderWithProviders(<ImportPasswordStep file={workbook([ROW_A, ROW_B])} />);
    await user.click(screen.getByRole('button', { name: /Set passwords/ }));

    expect(await screen.findByText(/Finished: 2 of 2/)).toBeInTheDocument();
    expect(maxInFlight).toBe(1);
  });

  it('offers to retry only the employees that failed', async () => {
    const user = userEvent.setup();
    // TEST100 succeeds; TEST101 is refused outright, then accepted on the retry.
    const puts: Array<{ url: string; password: string }> = [];
    let betaAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();

        if (method === 'PUT') {
          puts.push({ url, password: JSON.parse(String(init?.body)).password });
          if (url.endsWith('/12/password')) {
            betaAttempts += 1;
            if (betaAttempts === 1) {
              return jsonResponse(400, {
                success: false,
                error: 'Password must be at least 5 characters',
              });
            }
          }
          return jsonResponse(200, { success: true, data: { password_set: true } });
        }

        if (url.includes(`${EMPLOYEES}?`)) {
          return jsonResponse(200, {
            success: true,
            data: {
              employees: [
                { id: 11, amco_id: 'TEST100', full_name: 'X', roster_type: 'regular', is_active: 1 },
                { id: 12, amco_id: 'TEST101', full_name: 'X', roster_type: 'regular', is_active: 1 },
              ],
              total: 2,
            },
          });
        }

        return jsonResponse(404, { success: false, error: 'Not Found' });
      })
    );

    renderWithProviders(<ImportPasswordStep file={workbook([ROW_A, ROW_B])} />);
    await user.click(screen.getByRole('button', { name: /Set passwords/ }));
    await waitFor(() => expect(screen.getByText(/Finished: 1 of 2/)).toBeInTheDocument());
    expect(screen.getByText(/TEST101: Password must be at least 5 characters/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Retry the 1 that failed/ }));
    expect(await screen.findByText(/Finished: 1 of 1/)).toBeInTheDocument();

    // The retry touched ONLY the employee that failed, with their own password.
    expect(puts.slice(2)).toEqual([
      { url: `${EMPLOYEES}/12/password`, password: 'fixture-pass-b' },
    ]);
  });

  it('says so when the workbook carries no password column', async () => {
    const user = userEvent.setup();
    stubPasswordRoutes([{ id: 11, amco_id: 'TEST100' }]);

    renderWithProviders(
      <ImportPasswordStep
        file={workbook([['TEST100', 'Alpha Person', 'Mining', 'Operations', 'Regular']], {
          headers: ['ID', 'Name', 'Department', 'Section', 'Roster'],
        })}
      />
    );
    await user.click(screen.getByRole('button', { name: /Set passwords/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/No password column/);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stubPasswordRoutes(
  employees: Array<{ id: number; amco_id: string }>,
  overrides: Record<string, { status?: number; body: unknown }> = {}
) {
  const routes: Record<string, { status?: number; body: unknown }> = {
    [`${EMPLOYEES}?page=1&page_size=100`]: listPage(employees),
    ...Object.fromEntries(
      employees.map((e) => [
        `PUT ${EMPLOYEES}/${e.id}/password`,
        ok({ employee_id: e.id, amco_id: e.amco_id, password_set: true, sessionsRevoked: 0 }),
      ])
    ),
    ...overrides,
  };
  return stubFetchExact(routes);
}

function stubPagedRoutes(all: Array<{ id: number; amco_id: string }>) {
  const routes: Record<string, { status?: number; body: unknown }> = {};
  for (let page = 1; (page - 1) * 100 < all.length; page += 1) {
    routes[`${EMPLOYEES}?page=${page}&page_size=100`] = listPage(
      all.slice((page - 1) * 100, page * 100),
      all.length
    );
  }
  for (const e of all) {
    routes[`PUT ${EMPLOYEES}/${e.id}/password`] = ok({
      employee_id: e.id,
      amco_id: e.amco_id,
      password_set: true,
      sessionsRevoked: 0,
    });
  }
  return stubFetchExact(routes);
}

/**
 * Like the shared stubFetch, but matching on the FULL url including its query
 * string - paging is the thing under test here, so the page number must not be
 * thrown away by the matcher.
 */
function stubFetchExact(routes: Record<string, { status?: number; body: unknown }>) {
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const match = routes[`${method} ${url}`] ?? routes[url];
    if (!match) {
      return new Response(JSON.stringify({ success: false, error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function passwordPuts(spy: ReturnType<typeof vi.fn>) {
  return spy.mock.calls
    .filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'PUT')
    .map(([url, init]) => ({
      url: String(url),
      password: JSON.parse(String(init?.body)).password as string,
    }));
}
