/**
 * Typed wrappers for the endpoints the portal uses.
 * Every path is server-authoritative; the client adds no logic of its own.
 */

import { api } from './client.js';
import type { HistoryPayload, LunchChoice, SessionUser, TodayPayload } from '../types/index.js';

export const login = (amcoId: string, password: string) =>
  api.post<{ employee: SessionUser }>('/api/auth/login', {
    amco_id: amcoId,
    password,
  });

export const logout = () => api.post<null>('/api/auth/logout', {});

/**
 * Change YOUR OWN password.
 *
 * No user id is sent and none would be honoured: the server takes the account
 * from the session cookie. Every session is revoked on success, including this
 * one, so the caller has to sign in again.
 */
export const changeOwnPassword = (
  currentPassword: string,
  newPassword: string,
  confirmPassword: string
) =>
  api.put<{ password_changed: boolean; sessionsRevoked: number }>('/api/auth/change-password', {
    current_password: currentPassword,
    new_password: newPassword,
    confirm_password: confirmPassword,
  });

export const fetchSession = () => api.get<SessionUser>('/api/auth/me');

export const fetchToday = (date?: string) =>
  api.get<TodayPayload>(`/api/me/today${date ? `?date=${encodeURIComponent(date)}` : ''}`);

export const fetchHistory = (limit = 30, offset = 0) =>
  api.get<HistoryPayload>(`/api/me/selections/history?limit=${limit}&offset=${offset}`);

export const submitSelection = (mealDate: string, choice: LunchChoice) =>
  api.post<unknown>('/api/selections/me', { meal_date: mealDate, choice });
