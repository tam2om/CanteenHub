/**
 * Set an employee's password directly.
 *
 * The operational model is deliberate: the administrator types a password and
 * hands it to the employee in person. There is no reset link, reset token,
 * email or SMS flow, and no generator.
 *
 * Handling of the plaintext:
 *   - it exists only in this component's state while the form is open;
 *   - it is cleared the moment the request settles, success or failure;
 *   - it is never rendered back, copied to the clipboard, put in a URL, written
 *     to storage, or logged;
 *   - the server hashes it and returns a confirmation with no credential in it.
 */

import { useState, type FormEvent } from 'react';
import { useSetEmployeePassword } from '../../hooks/useAdmin.js';
import { ApiError } from '../../api/client.js';
import type { AdminEmployee } from '../../types/index.js';

interface Props {
  employee: AdminEmployee;
  onClose: () => void;
}

export function PasswordPanel({ employee, onClose }: Props) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [done, setDone] = useState<{ sessionsRevoked: number } | null>(null);

  const setPasswordMutation = useSetEmployeePassword();

  const clearFields = () => {
    setPassword('');
    setConfirmation('');
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setClientError(null);

    if (!password) {
      setClientError('Enter the new password.');
      return;
    }
    if (password !== confirmation) {
      // Catching the typo here matters more than usual: the administrator is
      // about to read this out to someone, and the value is never shown again.
      setClientError('The two passwords do not match.');
      return;
    }

    setPasswordMutation.mutate(
      { id: employee.id, password },
      {
        onSuccess: (result) => setDone({ sessionsRevoked: result.sessionsRevoked }),
        // Clear the plaintext from component state either way.
        onSettled: clearFields,
      }
    );
  };

  const serverError =
    setPasswordMutation.error instanceof ApiError
      ? setPasswordMutation.error.message
      : setPasswordMutation.error
        ? 'The password could not be set.'
        : null;

  if (done) {
    return (
      <section className="panel" aria-label="Password set">
        <h2 className="panel__title">Password set for {employee.amco_id}</h2>
        {/* The password itself is deliberately NOT shown again. */}
        <p className="feedback feedback--ok" role="status">
          The new password is now active. Give it to {employee.full_name} directly — it cannot be
          retrieved or displayed again.
        </p>
        <p className="panel__note">
          {done.sessionsRevoked === 0
            ? 'They had no active sessions.'
            : `${done.sessionsRevoked} active session${done.sessionsRevoked === 1 ? '' : 's'} ended, so the old password no longer works.`}
        </p>
        <div className="panel__actions">
          <button type="button" className="button button--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="panel" aria-label="Set password">
      <h2 className="panel__title">Set password for {employee.amco_id}</h2>
      <p className="panel__note">
        Type the password you will give to {employee.full_name}. Existing passwords cannot be
        viewed, and this one will not be shown again after you save it.
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <label className="field">
          <span className="field__label">New password</span>
          <input
            className="field__input"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Confirm password</span>
          <input
            className="field__input"
            name="confirm_password"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>

        {(clientError || serverError) && (
          <p className="feedback feedback--error" role="alert">
            {clientError ?? serverError}
          </p>
        )}

        <p className="panel__note">
          Saving this ends every active session for this employee.
        </p>

        <div className="panel__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              clearFields();
              onClose();
            }}
            disabled={setPasswordMutation.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={setPasswordMutation.isPending}
          >
            {setPasswordMutation.isPending ? 'Saving…' : 'Set password'}
          </button>
        </div>
      </form>
    </section>
  );
}
