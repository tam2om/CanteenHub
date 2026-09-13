/**
 * Change your own password, from the Profile page.
 *
 * WHOSE PASSWORD: the signed-in user's. No employee id is sent, and the server
 * would ignore one - it reads the account from the session cookie.
 *
 * Handling of the plaintext:
 *   - all three values live only in this component's state while the form is
 *     open, and are cleared the moment the request settles, either way;
 *   - nothing is written to storage, put in a URL, or logged;
 *   - the server returns a confirmation with no credential in it.
 *
 * On success every session is revoked, this one included. The panel says so
 * plainly and sends the user back to sign in rather than pretending the old
 * session survived.
 */

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChangeOwnPassword } from '../hooks/useSession.js';
import { ApiError } from '../api/client.js';
import { MIN_PASSWORD_LENGTH } from '../lib/passwordPolicy.js';

export function ChangePasswordPanel() {
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const navigate = useNavigate();
  const changeMutation = useChangeOwnPassword();

  const clearFields = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const close = () => {
    clearFields();
    setClientError(null);
    changeMutation.reset();
    setOpen(false);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setClientError(null);

    // These checks mirror the server's, they do not replace them: every one of
    // them is enforced again server-side, and the server is the authority.
    if (!currentPassword) {
      setClientError('Enter your current password.');
      return;
    }
    if (!newPassword) {
      setClientError('Enter a new password.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setClientError(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setClientError('The two new passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setClientError('The new password must be different from your current one.');
      return;
    }

    changeMutation.mutate(
      { currentPassword, newPassword, confirmPassword },
      {
        onSuccess: () => setDone(true),
        // Clear the plaintext from component state whatever the outcome.
        onSettled: clearFields,
      }
    );
  };

  const serverError =
    changeMutation.error instanceof ApiError
      ? changeMutation.error.message
      : changeMutation.error
        ? 'The password could not be changed.'
        : null;

  if (done) {
    return (
      <section className="card">
        <h2 className="card__title">Change password</h2>
        <p className="feedback feedback--ok" role="status">
          Your password has been changed. All of your sessions were signed out, including this
          one, so you need to sign in again with the new password.
        </p>
        <div className="panel__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => navigate('/login', { replace: true })}
          >
            Sign in again
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="card__title">Change password</h2>

      {!open ? (
        <>
          <p className="panel__note">
            Choose a new password for your own account. You need your current password, and you
            will be signed out everywhere once it changes.
          </p>
          <div className="panel__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => setOpen(true)}
            >
              Change password
            </button>
          </div>
        </>
      ) : (
        <form className="setting__form setting__form--stacked" onSubmit={handleSubmit}>
          <label className="field">
            <span className="field__label">Current password</span>
            <input
              className="field__input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>

          <div className="field">
            {/* The hint sits OUTSIDE the label on purpose: inside it, it would
                be read out as part of the field's accessible name. */}
            <label className="field__label" htmlFor="new-password">
              New password
            </label>
            <input
              id="new-password"
              className="field__input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <span className="field__hint">
              At least {MIN_PASSWORD_LENGTH} characters, and different from your current password.
            </span>
          </div>

          <label className="field">
            <span className="field__label">Confirm new password</span>
            <input
              className="field__input"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>

          {(clientError || serverError) && (
            <p className="feedback feedback--error" role="alert">
              {clientError ?? serverError}
            </p>
          )}

          <div className="panel__actions">
            <button type="button" className="button button--ghost" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={changeMutation.isPending}
            >
              {changeMutation.isPending ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
