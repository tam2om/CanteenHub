/**
 * Admin roster management endpoints.
 *
 * Thin wrappers over the existing /api/roster routes. No eligibility rule lives
 * here: the roster records Day, Night or Off, and what that earns is the
 * server's eligibility service's business alone.
 */

import { api } from './client.js';
import type { RosterDay, ShiftValue } from '../types/index.js';

/** Omitting `date` asks the server which business date "today" is. */
export const getRosterDay = (
  { date, search, rosterType }: { date?: string; search?: string; rosterType?: string } = {}
) => {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  if (search) params.set('search', search);
  if (rosterType) params.set('roster_type', rosterType);
  const query = params.toString();
  return api.get<RosterDay>(`/api/roster/admin/day${query ? `?${query}` : ''}`);
};

/** Source is not sent: anything written here is a manual edit by definition. */
export const setRosterEntry = (employeeId: number, workDate: string, shiftValue: ShiftValue) =>
  api.post<unknown>('/api/roster', {
    employee_id: employeeId,
    work_date: workDate,
    shift_value: shiftValue,
  });

/** Removes the entry so the roster becomes genuinely missing, not "off". */
export const removeRosterEntry = (employeeId: number, workDate: string) =>
  api.del<unknown>(`/api/roster/${employeeId}/${workDate}`);
