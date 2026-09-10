/**
 * Login.
 *
 * The password lives in local component state only for as long as the form is
 * on screen, and is cleared on failure. Nothing is written to localStorage: the
 * session is an HttpOnly cookie the browser holds and JavaScript cannot read.
 */

import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useLogin, useSession } from '../hooks/useSession.js';
import { ApiError } from '../api/client.js';
import { LoadingState } from '../components/States.js';

export function LoginPage() {
  const { isAuthenticated, isLoading } = useSession();
  const login = useLogin();

  const [amcoId, setAmcoId] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  if (isLoading) return <LoadingState label="Checking your session…" />;
  if (isAuthenticated) return <Navigate to="/" replace />;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setValidationError(null);

    if (!amcoId.trim() || !password) {
      setValidationError('Enter your AMCO ID and password.');
      return;
    }

    login.mutate(
      { amcoId: amcoId.trim(), password },
      // Clear the password from memory whether or not the attempt succeeded.
      { onSettled: () => setPassword('') }
    );
  };

  const serverError =
    login.error instanceof ApiError
      ? login.error.status === 401
        ? 'Invalid AMCO ID or password.'
        : login.error.message
      : login.error
        ? 'Sign-in failed. Please try again.'
        : null;

  return (
    <main className="login">
      <div className="login__card">
        <h1 className="login__title">CanteenHub</h1>
        <p className="login__subtitle">Sign in to choose your lunch.</p>

        <form onSubmit={handleSubmit} noValidate>
          <label className="field">
            <span className="field__label">AMCO ID</span>
            <input
              className="field__input"
              name="amco_id"
              type="text"
              autoComplete="username"
              autoCapitalize="characters"
              inputMode="text"
              value={amcoId}
              onChange={(e) => setAmcoId(e.target.value)}
              aria-invalid={Boolean(validationError)}
            />
          </label>

          <label className="field">
            <span className="field__label">Password</span>
            <input
              className="field__input"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(validationError)}
            />
          </label>

          {(validationError || serverError) && (
            <p className="feedback feedback--error" role="alert">
              {validationError ?? serverError}
            </p>
          )}

          <button type="submit" className="button button--primary" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="login__help">
          Forgotten your password? Ask the canteen administrator to set a new one.
        </p>
      </div>
    </main>
  );
}
