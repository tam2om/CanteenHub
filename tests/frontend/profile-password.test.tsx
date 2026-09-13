// @vitest-environment jsdom
/**
 * Frontend tests - changing your own password from the Profile page.
 *
 * Real components, hooks, router and API client; only `fetch` is stubbed. An
 * unmapped path returns 404, so no test can pass because of a silently
 * successful call. Every password here is invented.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ProfilePage } from '../../src/frontend/pages/ProfilePage.js';
import { renderWithProviders, stubFetch, todayPayload, ok, fail } from './helpers.js';
import { MIN_PASSWORD_LENGTH } from '../../src/frontend/lib/passwordPolicy.js';

const TODAY = '/api/me/today';
const CHANGE = 'PUT /api/auth/change-password';

const CURRENT = 'CurrentPass!2027';
const NEXT = 'NextPass!2027';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const routes = (overrides: Record<string, { status?: number; body: unknown }> = {}) => ({
  [TODAY]: ok(todayPayload()),
  [CHANGE]: ok({ password_changed: true, sessionsRevoked: 2 }),
  ...overrides,
});

/** Open the form and fill it in. */
async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  { current = CURRENT, next = NEXT, confirm = NEXT } = {}
) {
  await user.click(await screen.findByRole('button', { name: 'Change password' }));
  if (current) await user.type(screen.getByLabelText('Current password'), current);
  if (next) await user.type(screen.getByLabelText('New password'), next);
  if (confirm) await user.type(screen.getByLabelText('Confirm new password'), confirm);
}

const submit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Change password' }));

describe('Profile - change password', () => {
  it('offers Change Password on the Profile page', async () => {
    stubFetch(routes());
    renderWithProviders(<ProfilePage />);

    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Change password' })).toBeInTheDocument();
  });

  it('still shows the profile details it always did', async () => {
    stubFetch(routes());
    renderWithProviders(<ProfilePage />);

    expect(await screen.findByText('Portal Tester')).toBeInTheDocument();
    expect(screen.getByText('TEST001')).toBeInTheDocument();
  });

  it('shows the three fields', async () => {
    stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await user.click(await screen.findByRole('button', { name: 'Change password' }));

    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument();
  });

  it('masks every field, so nothing is shown on screen', async () => {
    stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);
    await user.click(await screen.findByRole('button', { name: 'Change password' }));

    for (const label of ['Current password', 'New password', 'Confirm new password']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('type', 'password');
    }
  });

  it('states the minimum length, matching the server policy', async () => {
    stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);
    await user.click(await screen.findByRole('button', { name: 'Change password' }));

    expect(
      screen.getByText(new RegExp(`At least ${MIN_PASSWORD_LENGTH} characters`, 'i'))
    ).toBeInTheDocument();
  });

  // --------------------------------------------------------------------------
  // Client-side validation - mirrors the server, never replaces it
  // --------------------------------------------------------------------------

  it('requires the current password', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user, { current: '' });
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your current password.');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('change-password'))).toBe(false);
  });

  it('rejects a 4-character new password without calling the server', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user, { next: 'abcd', confirm: 'abcd' });
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('at least 5 characters');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('change-password'))).toBe(false);
  });

  it('accepts a 5-character new password and sends it', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user, { next: 'abcde', confirm: 'abcde' });
    await submit(user);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('change-password'))).toBe(true)
    );
  });

  it('rejects a confirmation mismatch without calling the server', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user, { confirm: 'SomethingElse!2027' });
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('change-password'))).toBe(false);
  });

  it('rejects a new password identical to the current one', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user, { next: CURRENT, confirm: CURRENT });
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('different');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('change-password'))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // The request, the success state, and re-authentication
  // --------------------------------------------------------------------------

  it('sends all three fields and NO user id - the server uses the session', async () => {
    const fetchMock = stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user);
    await submit(user);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('change-password'))).toBe(true)
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('change-password'))!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe('PUT');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      current_password: CURRENT,
      new_password: NEXT,
      confirm_password: NEXT,
    });
    expect(Object.keys(body)).not.toContain('employee_id');
    expect(Object.keys(body)).not.toContain('id');
    // Never in the URL.
    expect(String(call[0])).not.toContain(NEXT);
  });

  it('reports success and says the session ended', async () => {
    stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user);
    await submit(user);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Your password has been changed');
    expect(status).toHaveTextContent(/signed out/i);
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
  });

  it('clears the fields from component state once the request settles', async () => {
    stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user);
    await submit(user);
    await screen.findByRole('status');

    // The form is gone, so no plaintext remains in any input.
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(NEXT);
    expect(document.body.innerHTML).not.toContain(CURRENT);
  });

  it('clears the fields even when the server rejects the change', async () => {
    stubFetch(routes({ [CHANGE]: fail(401, 'Current password is incorrect') }));
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user);
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect');
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(CURRENT);
  });

  it('surfaces a server rejection and does not claim success', async () => {
    stubFetch(routes({ [CHANGE]: fail(400, 'password must be at least 5 characters') }));
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user);
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('at least 5 characters');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument();
  });

  it('shows a busy label while the request is in flight', async () => {
    stubFetch(routes(), { delayPaths: ['/api/auth/change-password'] });
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user);
    await submit(user);

    expect(await screen.findByRole('button', { name: 'Changing…' })).toBeDisabled();
  });

  it('cancelling clears what was typed', async () => {
    stubFetch(routes());
    const user = userEvent.setup();
    renderWithProviders(<ProfilePage />);

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(document.body.innerHTML).not.toContain(CURRENT);
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  });
});
