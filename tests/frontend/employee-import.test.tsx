// @vitest-environment jsdom
/**
 * Frontend tests - employee import screen.
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
import { AdminEmployeeImportPage } from '../../src/frontend/pages/admin/AdminEmployeeImportPage.js';
import { renderWithProviders, stubFetch, ADMIN_USER, SESSION_USER, ok, fail } from './helpers.js';

const ME = '/api/auth/me';
const UPLOAD = 'POST /api/admin/imports';
const HISTORY = '/api/admin/imports?limit=10&offset=0&import_type=employees';
const detailPath = (id: number) => `/api/admin/imports/${id}`;
const validatePath = (id: number) => `/api/admin/imports/${id}/validate`;
const commitPath = (id: number) => `/api/admin/imports/${id}/commit`;

const BATCH_ID = 7;

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
    import_type: 'employees',
    status: 'preview',
    original_filename: 'synthetic-employees.xlsx',
    file_size_bytes: 2048,
    content_sha256: 'a'.repeat(64),
    uploaded_by: ADMIN_USER.id,
    uploaded_by_name: ADMIN_USER.full_name,
    uploaded_by_amco_id: ADMIN_USER.amco_id,
    committed_by: null,
    total_rows: 3,
    valid_rows: 3,
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
    full_name: 'Alpha Person',
    department: 'Mining',
    section: 'Operations',
    roster_type: 'regular',
  },
};

const UPDATE_ROW = {
  row_number: 3,
  status: 'valid',
  messages: [],
  preview: {
    action: 'UPDATE',
    amco_id: 'TEST101',
    full_name: 'Beta Person',
    department: 'Processing',
    section: 'Plant',
    roster_type: 'shift',
    changes: [{ field: 'roster_type', from: 'regular', to: 'shift' }],
  },
};

const UNCHANGED_ROW = {
  row_number: 4,
  status: 'valid',
  messages: [],
  preview: {
    action: 'UNCHANGED',
    amco_id: 'TEST102',
    full_name: 'Gamma Person',
    department: 'Mining',
    section: 'Operations',
    roster_type: 'regular',
  },
};

const INVALID_ROW = {
  row_number: 5,
  status: 'invalid',
  messages: ['Roster "Weekend" is not a recognised roster type.'],
  preview: {
    action: 'INVALID',
    amco_id: 'TEST103',
    full_name: 'Delta Person',
    department: 'Mining',
    section: 'Operations',
    roster_type: null,
  },
};

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...batch(),
    importer_available: true,
    committer_available: true,
    preview_rows: [CREATE_ROW, UPDATE_ROW, UNCHANGED_ROW],
    preview_row_limit: 100,
    ...overrides,
  };
}

const emptyHistory = ok({ imports: [], total: 0, limit: 10, offset: 0 });

/** A stand-in workbook. The screen never parses it; the server does. */
const workbookFile = () =>
  new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])], 'synthetic-employees.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

/** The happy-path route map; override any single entry per test. */
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

/** Choose a file and press upload; leaves the screen in the preview step. */
async function uploadWorkbook(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText('Workbook'), workbookFile());
  await user.click(screen.getByRole('button', { name: 'Upload and validate' }));
}

// ============================================================================
// ROUTING AND UPLOAD
// ============================================================================

describe('Employee import - upload step', () => {
  it('is reachable from the admin area', async () => {
    stubFetch(routes());

    renderWithProviders(<App />, { route: '/admin/imports/employees' });

    expect(await screen.findByRole('heading', { name: 'Import employees' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1. Choose a workbook' })).toBeInTheDocument();
  });

  it('is not reachable by an employee', async () => {
    stubFetch({ [ME]: ok(SESSION_USER) });

    renderWithProviders(<App />, { route: '/admin/imports/employees' });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Import employees' })).not.toBeInTheDocument()
    );
  });

  it('states that uploading alone changes nothing', async () => {
    stubFetch(routes());

    renderWithProviders(<AdminEmployeeImportPage />);

    expect(
      await screen.findByText(/Uploading does not change anything on its own/i)
    ).toBeInTheDocument();
  });

  it('refuses to upload when no file has been chosen', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);

    await user.click(await screen.findByRole('button', { name: 'Upload and validate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a workbook first.');
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === '/api/admin/imports')
    ).toHaveLength(0);
  });

  it('posts the workbook as multipart form data with the import type', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
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

    expect(body).toBeInstanceOf(FormData);
    expect(body.get('import_type')).toBe('employees');
    expect((body.get('file') as File).name).toBe('synthetic-employees.xlsx');
    expect(init.credentials).toBe('include');
  });

  it('shows a busy label while the upload is in flight', async () => {
    stubFetch(routes(), { delayPaths: ['/api/admin/imports'] });
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByRole('button', { name: 'Uploading…' })).toBeDisabled();
  });

  it('reports an upload rejection from the server', async () => {
    stubFetch(routes({ [UPLOAD]: fail(400, 'Only .xlsx workbooks can be imported.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
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

describe('Employee import - validation', () => {
  it('shows a validating state while the server works', async () => {
    stubFetch(routes(), { delayPaths: [validatePath(BATCH_ID)] });
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('Validating the workbook…')).toBeInTheDocument();
  });

  it('reports a validation failure from the server', async () => {
    stubFetch(routes({ [validatePath(BATCH_ID)]: fail(422, 'Sheet "All Employees" is missing.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('Sheet "All Employees" is missing.')).toBeInTheDocument();
  });

  it('reports a failure to load the batch itself', async () => {
    stubFetch(routes({ [detailPath(BATCH_ID)]: fail(500, 'The import could not be read.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('The import could not be read.')).toBeInTheDocument();
  });
});

// ============================================================================
// SUMMARY
// ============================================================================

describe('Employee import - validation summary', () => {
  it('names the uploaded file and counts every action', async () => {
    stubFetch(
      routes({
        [validatePath(BATCH_ID)]: ok(
          detail({ preview_rows: [CREATE_ROW, UPDATE_ROW, UNCHANGED_ROW], total_rows: 3 })
        ),
      })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const summary = (await screen.findByRole('heading', { name: '2. Validation summary' }))
      .closest('section')!;

    expect(within(summary).getByText('synthetic-employees.xlsx')).toBeInTheDocument();

    const counts = within(summary)
      .getAllByRole('listitem')
      .map((item) => item.textContent?.replace(/\s+/g, ' ').trim());

    expect(counts).toEqual(['3 rows read', '1 new', '1 updates', '1 unchanged', '0 invalid']);
  });

  it('renders workbook-level messages returned by the validator', async () => {
    stubFetch(
      routes({
        [validatePath(BATCH_ID)]: ok({
          ...detail(),
          messages: ['Column "Section" was empty for 2 rows.'],
        }),
      })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('Column "Section" was empty for 2 rows.')).toBeInTheDocument();
  });

  it('shows the server failure reason when validation rejected the workbook', async () => {
    const failed = detail({
      status: 'validation_failed',
      failure_reason: '1 row could not be imported.',
      invalid_rows: 1,
      preview_rows: [CREATE_ROW, INVALID_ROW],
      total_rows: 2,
    });
    stubFetch(routes({ [validatePath(BATCH_ID)]: ok(failed), [detailPath(BATCH_ID)]: ok(failed) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('1 row could not be imported.');
    expect(
      screen.getByText(/This workbook cannot be committed\./i)
    ).toBeInTheDocument();
    expect(screen.getByText(/no employee\s+record has been changed/i)).toBeInTheDocument();
  });
});

// ============================================================================
// ROW PREVIEW
// ============================================================================

describe('Employee import - row preview', () => {
  it('labels each row with the action the server assigned', async () => {
    const full = detail({ preview_rows: [CREATE_ROW, UPDATE_ROW, UNCHANGED_ROW, INVALID_ROW], total_rows: 4 });
    stubFetch(routes({ [validatePath(BATCH_ID)]: ok(full), [detailPath(BATCH_ID)]: ok(full) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const preview = (await screen.findByRole('heading', { name: '3. Row preview' })).closest(
      'section'
    )!;

    expect(within(preview).getByText('TEST100 — Alpha Person')).toBeInTheDocument();
    expect(within(preview).getByText('New')).toBeInTheDocument();
    expect(within(preview).getByText('Update')).toBeInTheDocument();
    expect(within(preview).getByText('Unchanged')).toBeInTheDocument();
    expect(within(preview).getByText('Cannot import')).toBeInTheDocument();
  });

  it('shows the before and after value of every changed field', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const preview = (await screen.findByRole('heading', { name: '3. Row preview' })).closest(
      'section'
    )!;
    const changes = within(preview).getByText('Roster').closest('li')!;

    expect(changes).toHaveTextContent('regular');
    expect(changes).toHaveTextContent('shift');
  });

  it('shows why an invalid row cannot be imported', async () => {
    const full = detail({
      status: 'validation_failed',
      preview_rows: [INVALID_ROW],
      total_rows: 1,
      invalid_rows: 1,
    });
    stubFetch(routes({ [validatePath(BATCH_ID)]: ok(full), [detailPath(BATCH_ID)]: ok(full) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(
      await screen.findByText('Roster "Weekend" is not a recognised roster type.')
    ).toBeInTheDocument();
  });

  it('says when only part of the workbook is being previewed', async () => {
    const truncated = detail({ total_rows: 500, preview_rows: [CREATE_ROW] });
    stubFetch(
      routes({ [validatePath(BATCH_ID)]: ok(truncated), [detailPath(BATCH_ID)]: ok(truncated) })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('Showing the first 1 of 500 rows.')).toBeInTheDocument();
  });
});

// ============================================================================
// CONFIRMATION AND COMMIT
// ============================================================================

describe('Employee import - confirmation', () => {
  it('never commits straight from the preview - confirmation is a separate step', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))
    ).toHaveLength(0);
  });

  it('spells out what the commit will and will not do', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));

    const dialog = await screen.findByRole('alertdialog');

    expect(dialog).toHaveTextContent('Invalid rows are never committed.');
    expect(dialog).toHaveTextContent(/will NOT be deactivated/);
    expect(dialog).toHaveTextContent(/passwords and meal history are preserved/);
    expect(dialog).toHaveTextContent('synthetic-employees.xlsx');
  });

  it('cancelling leaves the batch untouched', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))
    ).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Commit this import' })).toBeEnabled();
  });

  it('an invalid workbook cannot be committed at all', async () => {
    const failed = detail({
      status: 'validation_failed',
      invalid_rows: 1,
      preview_rows: [CREATE_ROW, INVALID_ROW],
      total_rows: 2,
    });
    const fetchMock = stubFetch(
      routes({ [validatePath(BATCH_ID)]: ok(failed), [detailPath(BATCH_ID)]: ok(failed) })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
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

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByRole('button', { name: 'Commit this import' })).toBeDisabled();
  });
});

describe('Employee import - commit', () => {
  it('commits the batch the server issued and reports the outcome', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));

    expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(
      '1 employee created and 1 updated from synthetic-employees.xlsx.'
    );
    expect(
      screen.getByText(/cannot sign in until you set a password for them/i)
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))
    ).toHaveLength(1);
  });

  it('shows a busy label while the commit is in flight', async () => {
    stubFetch(routes(), { delayPaths: [commitPath(BATCH_ID)] });
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));

    expect(await screen.findByRole('button', { name: 'Working…' })).toBeDisabled();
  });

  it('surfaces a commit rejection and does not claim success', async () => {
    stubFetch(routes({ [commitPath(BATCH_ID)]: fail(409, 'This import has already been committed.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminEmployeeImportPage />);
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

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Start over' }));

    expect(
      await screen.findByRole('heading', { name: '1. Choose a workbook' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '2. Validation summary' })).not.toBeInTheDocument();
  });
});

// ============================================================================
// HISTORY
// ============================================================================

describe('Employee import - history', () => {
  it('says so when no employee import has run', async () => {
    stubFetch(routes());

    renderWithProviders(<AdminEmployeeImportPage />);

    expect(await screen.findByText('No employee imports yet.')).toBeInTheDocument();
  });

  it('lists previous employee imports with their server-supplied timestamps', async () => {
    stubFetch(
      routes({
        [HISTORY]: ok({
          imports: [batch({ id: 3, status: 'committed', original_filename: 'earlier.xlsx' })],
          total: 1,
          limit: 10,
          offset: 0,
        }),
      })
    );

    renderWithProviders(<AdminEmployeeImportPage />);

    const history = (await screen.findByText('earlier.xlsx')).closest('section')!;

    expect(within(history).getByRole('heading', { name: 'Recent employee imports' })).toBeInTheDocument();
    expect(within(history).getByText(/2027-03-07 08:00:00/)).toBeInTheDocument();
    expect(within(history).getByText('committed')).toBeInTheDocument();
  });

  it('reports a history failure without breaking the upload step', async () => {
    stubFetch(routes({ [HISTORY]: fail(500, 'The history could not be loaded.') }));

    renderWithProviders(<AdminEmployeeImportPage />);

    expect(await screen.findByText('The history could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1. Choose a workbook' })).toBeInTheDocument();
  });
});

// ============================================================================
// SECRETS
// ============================================================================

describe('Employee import - handles no credentials', () => {
  it('offers no password field and stores nothing in the browser', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();
    localStorage.clear();
    sessionStorage.clear();

    renderWithProviders(<AdminEmployeeImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));
    await screen.findByRole('heading', { name: 'Import complete' });

    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    // Nothing on this screen ever names a credential, in a request or on screen.
    for (const [url, init] of fetchMock.mock.calls) {
      const body = (init as RequestInit | undefined)?.body;
      const serialised = typeof body === 'string' ? body : '';
      expect(`${String(url)} ${serialised}`).not.toMatch(/password|token|secret/i);
    }
    expect(document.body.textContent ?? '').not.toMatch(/password_hash|session_token/i);
  });
});
