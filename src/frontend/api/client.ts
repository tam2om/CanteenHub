/**
 * API client.
 *
 * Authentication rides entirely on the HttpOnly session cookie the backend
 * sets at login. The portal therefore stores no token, no password and no
 * credential of any kind - there is nothing in localStorage or React state for
 * an XSS to steal, and `credentials: 'include'` is the whole of the auth code.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Thrown for any non-2xx response, carrying the server's own message. */
export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }

  /** The session is gone or expired; the UI should return to login. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });

  let body: { success?: boolean; data?: unknown; error?: string } | null = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || body?.success === false) {
    // Surface the server's message: it is written for the employee, and the
    // client has no business inventing its own explanation of a refusal.
    throw new ApiError(
      response.status,
      body?.error ?? `Request failed (${response.status})`,
      body
    );
  }

  return (body?.data ?? null) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
