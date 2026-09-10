// @vitest-environment jsdom
/**
 * Frontend tests - lunch menu import screen.
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
import { AdminMenuImportPage } from '../../src/frontend/pages/admin/AdminMenuImportPage.js';
import { renderWithProviders, stubFetch, ADMIN_USER, SESSION_USER, ok, fail } from './helpers.js';

const ME = '/api/auth/me';
const UPLOAD = 'POST /api/admin/imports';
const HISTORY = '/api/admin/imports?limit=10&offset=0&import_type=menu';
const detailPath = (id: number) => `/api/admin/imports/${id}`;
const validatePath = (id: number) => `/api/admin/imports/${id}/validate`;
const commitPath = (id: number) => `/api/admin/imports/${id}/commit`;

const BATCH_ID = 21;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function batch(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    import_type: 'menu',
    status: 'preview',
    original_filename: 'synthetic-menu.xlsx',
    file_size_bytes: 3072,
    content_sha256: 'c'.repeat(64),
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
    meal_date: '2027-03-01',
    option_1: 'Test Main Alpha',
    option_2: 'Test Main Beta',
    components: [
      { component_type: 'salad', label: 'salad', name: 'Test Salad', action: 'CREATE', from: null },
    ],
    changes: [],
    current_status: null,
  },
};

const UPDATE_ROW = {
  row_number: 3,
  status: 'valid',
  messages: [],
  preview: {
    action: 'UPDATE',
    meal_date: '2027-03-02',
    option_1: 'Test Main Gamma',
    option_2: 'Test Main Delta',
    components: [
      { component_type: 'dessert', label: 'dessert', name: 'Test Fruit', action: 'UPDATE', from: 'Old Fruit' },
      { component_type: 'beverage', label: 'beverage', name: 'Test Juice', action: 'UNCHANGED', from: 'Test Juice' },
    ],
    changes: [{ field: 'option_1', from: 'Old Gamma', to: 'Test Main Gamma' }],
    current_status: 'published',
  },
};

const INVALID_ROW = {
  row_number: 4,
  status: 'invalid',
  messages: ['Option 2 is missing. A menu day needs both options.'],
  preview: {
    action: 'INVALID',
    meal_date: '2027-03-03',
    option_1: 'Test Main Epsilon',
    option_2: '',
    components: [],
    changes: [],
    current_status: null,
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
  new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])], 'synthetic-menu.xlsx', {
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

describe('Menu import - upload step', () => {
  it('is reachable from the admin area', async () => {
    stubFetch(routes());
    renderWithProviders(<App />, { route: '/admin/imports/menu' });
    expect(await screen.findByRole('heading', { name: 'Import lunch menu' })).toBeInTheDocument();
  });

  it('is not reachable by an employee', async () => {
    stubFetch({ [ME]: ok(SESSION_USER) });
    renderWithProviders(<App />, { route: '/admin/imports/menu' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Import lunch menu' })).not.toBeInTheDocument()
    );
  });

  it('says clearly that this is the LUNCH menu and explains the accompaniment trap', async () => {
    stubFetch(routes());
    renderWithProviders(<AdminMenuImportPage />);

    expect(await screen.findByRole('heading', { name: 'Import lunch menu' })).toBeInTheDocument();
    expect(screen.getByText(/a dinner sheet is never read as lunch/i)).toBeInTheDocument();
    expect(screen.getByText(/imported as components/i)).toBeInTheDocument();
    expect(screen.getByText(/Option 1,\s*Option 2 or No Preference/i)).toBeInTheDocument();
  });

  it('refuses to upload when no file has been chosen', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await user.click(await screen.findByRole('button', { name: 'Upload and validate' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a workbook first.');
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/admin/imports')).toHaveLength(0);
  });

  it('posts the workbook with import_type "menu"', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/admin/imports' && (init as RequestInit | undefined)?.method === 'POST'
        )
      ).toBe(true)
    );

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === '/api/admin/imports' && (init as RequestInit | undefined)?.method === 'POST'
    )!;
    const init = call[1] as RequestInit;
    const body = init.body as FormData;

    expect(body.get('import_type')).toBe('menu');
    expect(init.credentials).toBe('include');
  });

  it('shows a busy label while the upload is in flight', async () => {
    stubFetch(routes(), { delayPaths: ['/api/admin/imports'] });
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByRole('button', { name: 'Uploading…' })).toBeDisabled();
  });

  it('reports an upload rejection from the server', async () => {
    stubFetch(routes({ [UPLOAD]: fail(400, 'Only .xlsx workbooks can be imported.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Only .xlsx workbooks can be imported.');
  });
});

// ============================================================================
// VALIDATION
// ============================================================================

describe('Menu import - validation', () => {
  it('shows a validating state while the server works', async () => {
    stubFetch(routes(), { delayPaths: [validatePath(BATCH_ID)] });
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('Validating the workbook…')).toBeInTheDocument();
  });

  it('reports a validation failure from the server', async () => {
    stubFetch(routes({ [validatePath(BATCH_ID)]: fail(422, 'No lunch worksheet was found.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('No lunch worksheet was found.')).toBeInTheDocument();
  });

  it('reports a failure to load the batch itself', async () => {
    stubFetch(routes({ [detailPath(BATCH_ID)]: fail(500, 'The import could not be read.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('The import could not be read.')).toBeInTheDocument();
  });
});

// ============================================================================
// SUMMARY AND PREVIEW
// ============================================================================

describe('Menu import - summary and preview', () => {
  it('counts each action', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const summary = (await screen.findByRole('heading', { name: '2. Validation summary' })).closest(
      'section'
    )!;
    const counts = within(summary)
      .getAllByRole('listitem')
      .map((item) => item.textContent?.replace(/\s+/g, ' ').trim());

    expect(counts).toEqual(['2 rows read', '1 new days', '1 changed', '0 already correct', '0 invalid']);
    expect(within(summary).getByText('synthetic-menu.xlsx')).toBeInTheDocument();
  });

  it('renders workbook-level messages returned by the validator', async () => {
    stubFetch(
      routes({
        [validatePath(BATCH_ID)]: ok({
          ...detail(),
          messages: ['New menu days are created as drafts.'],
        }),
      })
    );
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('New menu days are created as drafts.')).toBeInTheDocument();
  });

  it('shows the date, both options and the current status per row', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const preview = (await screen.findByRole('heading', { name: '3. Row preview' })).closest('section')!;
    const updateRow = within(preview).getByText('2027-03-02').closest('li')!;

    expect(updateRow).toHaveTextContent('1: Test Main Gamma');
    expect(updateRow).toHaveTextContent('2: Test Main Delta');
    expect(updateRow).toHaveTextContent('currently published');
    expect(within(preview).getByText('New')).toBeInTheDocument();
    expect(within(preview).getByText('Changes')).toBeInTheDocument();
  });

  it('shows from/to for changed options and components, hiding unchanged ones', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const preview = (await screen.findByRole('heading', { name: '3. Row preview' })).closest('section')!;
    const updateRow = within(preview).getByText('2027-03-02').closest('li')!;

    const optionChange = within(updateRow).getByText('Option 1').closest('li')!;
    expect(optionChange).toHaveTextContent('Old Gamma');
    expect(optionChange).toHaveTextContent('Test Main Gamma');

    const dessertChange = within(updateRow).getByText('Dessert / fruit').closest('li')!;
    expect(dessertChange).toHaveTextContent('Old Fruit');
    expect(dessertChange).toHaveTextContent('Test Fruit');

    // The UNCHANGED beverage is not listed as a change.
    expect(within(updateRow).queryByText('Beverage')).not.toBeInTheDocument();
  });

  it('shows why an invalid row cannot be imported', async () => {
    const failed = detail({
      status: 'validation_failed',
      invalid_rows: 1,
      failure_reason: '1 row could not be imported.',
      preview_rows: [CREATE_ROW, INVALID_ROW],
    });
    stubFetch(routes({ [validatePath(BATCH_ID)]: ok(failed), [detailPath(BATCH_ID)]: ok(failed) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(
      await screen.findByText('Option 2 is missing. A menu day needs both options.')
    ).toBeInTheDocument();
    expect(screen.getByText(/no menu has been\s+changed/)).toBeInTheDocument();
  });

  it('says when only part of the workbook is being previewed', async () => {
    const truncated = detail({ total_rows: 300, preview_rows: [CREATE_ROW] });
    stubFetch(routes({ [validatePath(BATCH_ID)]: ok(truncated), [detailPath(BATCH_ID)]: ok(truncated) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByText('Showing the first 1 of 300 rows.')).toBeInTheDocument();
  });
});

// ============================================================================
// CONFIRMATION AND COMMIT
// ============================================================================

describe('Menu import - confirmation', () => {
  it('never commits straight from the preview', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))).toHaveLength(0);
  });

  it('spells out that nothing is published and no selection is changed', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/created as drafts/);
    expect(dialog).toHaveTextContent(/nothing is published or unpublished/);
    expect(dialog).toHaveTextContent(/lunch selections are\s*never changed/);
    expect(dialog).toHaveTextContent('synthetic-menu.xlsx');
  });

  it('cancelling leaves the batch untouched', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))).toHaveLength(0);
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

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    const commitButton = await screen.findByRole('button', { name: 'Commit this import' });
    expect(commitButton).toBeDisabled();

    await user.click(commitButton);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))).toHaveLength(0);
  });

  it('commit stays gated on SERVER status, not on a file being chosen', async () => {
    // A batch the server has not moved to `preview` cannot be committed, even
    // though the administrator has a file and a rendered preview.
    const pending = detail({ status: 'validating' });
    stubFetch(routes({ [validatePath(BATCH_ID)]: ok(pending), [detailPath(BATCH_ID)]: ok(pending) }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);

    expect(await screen.findByRole('button', { name: 'Commit this import' })).toBeDisabled();
  });
});

describe('Menu import - commit', () => {
  it('commits and reports the outcome', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));

    expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(
      '1 menu day created and 1 updated from synthetic-menu.xlsx.'
    );
    expect(screen.getByText(/this import never publishes one/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === commitPath(BATCH_ID))).toHaveLength(1);
  });

  it('shows a busy label while the commit is in flight', async () => {
    stubFetch(routes(), { delayPaths: [commitPath(BATCH_ID)] });
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Commit this import' }));
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));

    expect(await screen.findByRole('button', { name: 'Working…' })).toBeDisabled();
  });

  it('surfaces a commit rejection and does not claim success', async () => {
    stubFetch(routes({ [commitPath(BATCH_ID)]: fail(409, 'This import has already been committed.') }));
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
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

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await user.click(await screen.findByRole('button', { name: 'Start over' }));

    expect(await screen.findByRole('heading', { name: '1. Choose a workbook' })).toBeInTheDocument();
  });
});

// ============================================================================
// HISTORY AND SECRETS
// ============================================================================

describe('Menu import - history', () => {
  it('asks the history API for menu imports only', async () => {
    const fetchMock = stubFetch(routes());
    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByText('No menu imports yet.');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('import_type=menu'))).toBe(true);
  });

  it('lists previous menu imports', async () => {
    stubFetch(
      routes({
        [HISTORY]: ok({
          imports: [batch({ id: 5, status: 'committed', original_filename: 'march-menu.xlsx' })],
          total: 1,
          limit: 10,
          offset: 0,
        }),
      })
    );

    renderWithProviders(<AdminMenuImportPage />);
    const history = (await screen.findByText('march-menu.xlsx')).closest('section')!;
    expect(within(history).getByText('committed')).toBeInTheDocument();
  });

  it('reports a history failure without breaking the upload step', async () => {
    stubFetch(routes({ [HISTORY]: fail(500, 'The history could not be loaded.') }));
    renderWithProviders(<AdminMenuImportPage />);

    expect(await screen.findByText('The history could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1. Choose a workbook' })).toBeInTheDocument();
  });
});

describe('Menu import - handles no credentials', () => {
  it('offers no password field and stores nothing in the browser', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();
    localStorage.clear();
    sessionStorage.clear();

    renderWithProviders(<AdminMenuImportPage />);
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

  it('computes no eligibility or business date in the browser', async () => {
    stubFetch(routes());
    const user = userEvent.setup();

    renderWithProviders(<AdminMenuImportPage />);
    await screen.findByRole('button', { name: 'Upload and validate' });
    await uploadWorkbook(user);
    await screen.findByRole('heading', { name: '3. Row preview' });

    // Dates are rendered exactly as the server supplied them.
    expect(screen.getByText('2027-03-01')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/eligible|ROSTER_MISSING/i);
  });
});
