// @vitest-environment jsdom
/**
 * Frontend tests - shift roster import screen.
 *
 * Real components, hooks, router and API client; only `fetch` is stubbed. An
 * unmapped path returns 404, so no test can pass because of a silently
 * successful call. Every fixture is synthetic - no real employee data.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { App } from '../../src/frontend/App.js';
import { AdminRosterImportPage } from '../../src/frontend/pages/admin/AdminRosterImportPage.js';
import { renderWithProviders, stubFetch, ADMIN_USER, SESSION_USER, ok, fail } from './helpers.js';

const ME = '/api/auth/me';
const UPLOAD = 'POST /api/admin/imports';
const HISTORY = '/api/admin/imports?limit=10&offset=0&import_type=roster';
const detailPath = (id: number) => `/api/admin/imports/${id}`;
const validatePath = (id: number) => `/api/admin/imports/${id}/validate`;
const commitPath = (id: number) => `/api/admin/imports/${id}/commit`;

const BATCH_ID = 11;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function batch(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    import_type: 'roster',
    status: 'preview',
    original_filename: 'synthetic-roster.xlsx',
    file_size_bytes: 4096,
    content_sha256: 'b'.repeat(64),
    file_archived: true,
    uploaded_by: ADMIN_USER.id,
    uploaded_by_name: ADMIN_USER.full_name,
    uploaded_by_amco_id: ADMIN_USER.amco_id,
    committed_by: null,
    total_rows: 2,
    valid_rows: 2,
    invalid_rows: 0,
    warning_rows: 0,
    failure_reason: null,
    created_at: '2027-03-07 08:00:00',
    validated_at: '2027-03-07 08:00:01',
    committed_at: null,
    ...overrides,
  };
}

const CREATE_ROW = {
  row_number: 2,
  status: 'valid',
  messages: [],
  preview: {
    action: 'CREATE',
    amco_id: 'TEST100',
    month: 3,
    year: 2027,
    days: [
      { work_date: '2027-03-01', action: 'CREATE', from: null, to: 'day' },
      { work_date: '2027-03-02', action: 'CREATE', from: null, to: 'night' },
    ],
    counts: { create: 2, update: 0, unchanged: 0 },
  },
};

const UPDATE_ROW = {
  row_number: 3,
  status: 'valid',
  messages: [],
  preview: {
    action: 'UPDATE',
    amco_id: 'TEST101',
    month: 3,
    year: 2027,
    days: [
      { work_date: '2027-03-01', action: 'UPDATE', from: 'off', to: 'day' },
      { work_date: '2027-03-02', action: 'UNCHANGED', from: 'night', to: 'night' },
    ],
    counts: { create: 0, update: 1, unchanged: 1 },
  },
};

const INVALID_ROW = {
  row_number: 4,
  status: 'invalid',
  messages: ['No employee with AMCO ID "TEST404" exists.'],
  preview: {
    action: 'INVALID',
    amco_id: 'TEST404',
    month: 3,
    year: 2027,
    days: [],
    counts: { create: 0, update: 0, unchanged: 0 },
  },
};

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...batch(),
    importer_available: true,
    committer_available: true,
    preview_rows: [CREATE_ROW, UPDATE_ROW],
    preview_row_limit: 100,
    ...overrides,
  };
}

const emptyHistory = ok({ imports: [], total: 0, limit: 10, offset: 0 });

const workbookFile = () =>
  new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])], 'synthetic-roster.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

function routes(overrides: Record<string, { status?: number; body: unknown }> = {}) {
  return {
    [ME]: ok(ADMIN_USER),
    [HISTORY]: emptyHistory,
    [UPLOAD]: ok(batch({ status: 'pending', validated_at: null })),
    [validatePath(BATCH_ID)]: ok(detail()),
    [detailPath(BATCH_ID)]: ok(detail()),
    [commitPath(BATCH_ID)]: ok(detail({ status: 'committed', committed_at: '2027-03-07 08:01:00' })),
    ...overrides,
  };
}

async function uploadWorkbook(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText('Workbook'), workbookFile());
  await user.click(screen.getByRole('button', { name: 'Upload and validate' }));
}

// ============================================================================
// ROUTING AND UPLOAD
// ============================================================================

describe('Roster import - upload step', () => {
  it('is reachable from the admin area', async () => {
    stubFetch(routes());

    renderWithProviders(<App />, { route: '/admin/imports/roster' });

    expect(await screen.findByRole('heading', { name: 'Import shift roster' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1. Choose a workbook' })).toBeInTheDocument();
  });

  it('is not reachable by an employee', async () => {
    stubFetch({ [ME]: ok(SESSION_USER) });

    renderWithProviders(<App />, { route: '/admin/imports/roster' });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Import shift roster' })).not.toBeInTheDocument()
    );
  });

  it('describes the real wide-month sheet shape', async () => {
    stubFetch(routes());

    renderWithProviders(<AdminRosterImportPage />);

    expect(await screen.findByText(/Shifts roster/)).toBeInTheDocument();
    expect(screen.getByText(/Off, Day or Night/)).toBeInTheDocument();
    expect(screen.getByText(/Uploading does not change anything on its own/)).toBeInTheDocument();
  });

  it('refuses to upload when no file has been chosen', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await user.click(await screen.findByRole('button', { name: 'Upload and validate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a workbook first.');
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === '/api/admin/imports')
    ).toHaveLength(0);
  });

  it('posts the workbook with import_type "roster"', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/admin/imports' &&
            (init as RequestInit | undefined)?.method === 'POST'
        )
      ).toBe(true)
    );

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === '/api/admin/imports' && (init as RequestInit | undefined)?.method === 'POST'
    )!;
    const init = call[1] as RequestInit;
    const body = init.body as FormData;

    expect(body.get('import_type')).toBe('roster');
    expect((body.get('file') as File).name).toBe('synthetic-roster.xlsx');
    expect(init.credentials).toBe('include');
  });

  it('shows a busy label while the upload is in flight', async () => {
    stubFetch(routes(), { delayPaths: ['/api/admin/imports'] });
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByRole('button', { name: 'Uploading…' })).toBeDisabled();
  });

  it('reports an upload rejection from the server', async () => {
    stubFetch(routes({ [UPLOAD]: fail(400, 'Only .xlsx workbooks can be imported.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only .xlsx workbooks can be imported.'
    );
  });
});

// ============================================================================
// VALIDATION
// ============================================================================

describe('Roster import - validation', () => {
  it('shows a validating state while the server works', async () => {
    stubFetch(routes(), { delayPaths: [validatePath(BATCH_ID)] });
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('Validating the workbook…')).toBeInTheDocument();
  });

  it('reports a validation failure from the server', async () => {
    stubFetch(routes({ [validatePath(BATCH_ID)]: fail(422, 'Sheet "Shifts roster" is missing.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('Sheet "Shifts roster" is missing.')).toBeInTheDocument();
  });

  it('reports a failure to load the batch itself', async () => {
    stubFetch(routes({ [detailPath(BATCH_ID)]: fail(500, 'The import could not be read.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('The import could not be read.')).toBeInTheDocument();
  });
});

// ============================================================================
// SUMMARY AND PREVIEW
// ============================================================================

describe('Roster import - summary', () => {
  it('counts DAYS, not just rows, across the whole workbook', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const summary = (await screen.findByRole('heading', { name: '2. Validation summary' }))
      .closest('section')!;

    const counts = within(summary)
      .getAllByRole('listitem')
      .map((item) => item.textContent?.replace(/\s+/g, ' ').trim());

    // 2 rows; days roll up as 2 new, 1 changed, 1 already correct.
    expect(counts).toEqual([
      '2 rows read',
      '2 new days',
      '1 changed days',
      '1 already correct',
      '0 invalid rows',
    ]);
    expect(within(summary).getByText('synthetic-roster.xlsx')).toBeInTheDocument();
  });

  it('renders workbook-level messages returned by the validator', async () => {
    stubFetch(
      routes({
        [validatePath(BATCH_ID)]: ok({
          ...detail(),
          messages: ['Dates this workbook does not mention are left exactly as they are.'],
        }),
      })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(
      await screen.findByText('Dates this workbook does not mention are left exactly as they are.')
    ).toBeInTheDocument();
  });

  it('shows the failure reason and a reassurance when validation rejected the workbook', async () => {
    const failed = detail({
      status: 'validation_failed',
      failure_reason: '1 row could not be imported.',
      invalid_rows: 1,
      preview_rows: [CREATE_ROW, INVALID_ROW],
    });
    stubFetch(routes({ [validatePath(BATCH_ID)]: ok(failed), [detailPath(BATCH_ID)]: ok(failed) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('1 row could not be imported.');
    expect(screen.getByText(/no roster entry\s+has been changed/)).toBeInTheDocument();
  });
});

describe('Roster import - row preview', () => {
  it('labels each row and names the employee-month', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const preview = (await screen.findByRole('heading', { name: '3. Row preview' })).closest(
      'section'
    )!;

    expect(within(preview).getByText('TEST100 — 03/2027')).toBeInTheDocument();
    expect(within(preview).getByText('New')).toBeInTheDocument();
    expect(within(preview).getByText('Changes')).toBeInTheDocument();
  });

  it('shows the before and after shift for each CHANGED day only', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const preview = (await screen.findByRole('heading', { name: '3. Row preview' })).closest(
      'section'
    )!;

    const updateRow = within(preview).getByText('TEST101 — 03/2027').closest('li')!;
    const changeLine = within(updateRow).getByText('2027-03-01').closest('li')!;
    expect(changeLine).toHaveTextContent('Off');
    expect(changeLine).toHaveTextContent('Day');

    // The UNCHANGED day is not listed as a change.
    expect(within(updateRow).queryByText('2027-03-02')).not.toBeInTheDocument();
  });

  it('shows why an invalid row cannot be imported', async () => {
    const failed = detail({ status: 'validation_failed', preview_rows: [INVALID_ROW], invalid_rows: 1 });
    stubFetch(routes({ [validatePath(BATCH_ID)]: ok(failed), [detailPath(BATCH_ID)]: ok(failed) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(
      await screen.findByText('No employee with AMCO ID "TEST404" exists.')
    ).toBeInTheDocument();
  });

  it('says when only part of the workbook is being previewed', async () => {
    const truncated = detail({ total_rows: 400, preview_rows: [CREATE_ROW] });
    stubFetch(
      routes({ [validatePath(BATCH_ID)]: ok(truncated), [detailPath(BATCH_ID)]: ok(truncated) })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('Showing the first 1 of 400 rows.')).toBeInTheDocument();
  });

  it('renders no eligibility verdict anywhere - that is the server\'s business', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await screen.findByRole('heading', { name: '3. Row preview' });

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/eligible|ROSTER_MISSING|not entitled/i);
  });
});

// ============================================================================
// CONFIRMATION AND COMMIT
// ============================================================================

describe('Roster import - confirmation', () => {
  it('never commits straight from the preview', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))
    ).toHaveLength(0);
  });

  it('spells out that omitted dates are NOT cleared', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));

    const dialog = await screen.findByRole('alertdialog');

    expect(dialog).toHaveTextContent(/does not mention are left exactly as they are/);
    expect(dialog).toHaveTextContent(/nothing is cleared or deleted/);
    expect(dialog).toHaveTextContent(/passwords and meal selections are not touched/);
    expect(dialog).toHaveTextContent('synthetic-roster.xlsx');
  });

  it('cancelling leaves the batch untouched', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))
    ).toHaveLength(0);
  });

  it('an invalid workbook cannot be committed at all', async () => {
    const failed = detail({
      status: 'validation_failed',
      invalid_rows: 1,
      preview_rows: [CREATE_ROW, INVALID_ROW],
    });
    const fetchMock = stubFetch(
      routes({ [validatePath(BATCH_ID)]: ok(failed), [detailPath(BATCH_ID)]: ok(failed) })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const commitButton = await screen.findByRole('button', { name: 'Commit this import' });
    expect(commitButton).toBeDisabled();

    await user.click(commitButton);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))
    ).toHaveLength(0);
  });

  it('an already-committed batch cannot be committed again', async () => {
    const done = detail({ status: 'committed', committed_at: '2027-03-07 08:01:00' });
    stubFetch(routes({ [validatePath(BATCH_ID)]: ok(done), [detailPath(BATCH_ID)]: ok(done) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByRole('button', { name: 'Commit this import' })).toBeDisabled();
  });
});

describe('Roster import - commit', () => {
  it('commits and reports the outcome in days', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));

    expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(
      '2 roster days created and 1 updated from synthetic-roster.xlsx.'
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))
    ).toHaveLength(1);
  });

  it('shows a busy label while the commit is in flight', async () => {
    stubFetch(routes(), { delayPaths: [commitPath(BATCH_ID)] });
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));

    expect(await screen.findByRole('button', { name: 'Working…' })).toBeDisabled();
  });

  it('surfaces a commit rejection and does not claim success', async () => {
    stubFetch(
      routes({ [commitPath(BATCH_ID)]: fail(409, 'This import has already been committed.') })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));

    expect(await screen.findByText('This import has already been committed.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Import complete' })).not.toBeInTheDocument();
  });

  it('starting over returns to the upload step', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Start over' }));

    expect(await screen.findByRole('heading', { name: '1. Choose a workbook' })).toBeInTheDocument();
  });
});

// ============================================================================
// HISTORY
// ============================================================================

describe('Roster import - history', () => {
  it('asks the history API for roster imports only', async () => {
    const fetchMock = stubFetch(routes());

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByText('No roster imports yet.');

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('import_type=roster'))
    ).toBe(true);
  });

  it('lists previous roster imports with their server-supplied timestamps', async () => {
    stubFetch(
      routes({
        [HISTORY]: ok({
          imports: [batch({ id: 4, status: 'committed', original_filename: 'march.xlsx' })],
          total: 1,
          limit: 10,
          offset: 0,
        }),
      })
    );

    renderWithProviders(<AdminRosterImportPage />);

    const history = (await screen.findByText('march.xlsx')).closest('section')!;
    expect(within(history).getByText(/2027-03-07 08:00:00/)).toBeInTheDocument();
    expect(within(history).getByText('committed')).toBeInTheDocument();
  });

  it('reports a history failure without breaking the upload step', async () => {
    stubFetch(routes({ [HISTORY]: fail(500, 'The history could not be loaded.') }));

    renderWithProviders(<AdminRosterImportPage />);

    expect(await screen.findByText('The history could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1. Choose a workbook' })).toBeInTheDocument();
  });
});

// ============================================================================
// SECRETS
// ============================================================================

describe('Roster import - handles no credentials', () => {
  it('offers no password field and stores nothing in the browser', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();
    localStorage.clear();
    sessionStorage.clear();

    renderWithProviders(<AdminRosterImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));
    await screen.findByRole('heading', { name: 'Import complete' });

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
