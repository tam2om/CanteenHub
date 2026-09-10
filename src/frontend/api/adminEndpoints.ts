/**
 * Admin API wrappers.
 *
 * Thin typed calls over the SAME authenticated client the employee portal uses
 * (HttpOnly session cookie, `credentials: 'include'`). No second auth mechanism,
 * no client-side identity, and every path is an existing Slice 1 endpoint.
 */

import { api } from './client.js';
import type {
  AdminEmployee,
  AdminEmployeeList,
  CreateEmployeeInput,
  EmployeeFilters,
  Holiday,
  PasswordSetResult,
  Setting,
  UpdateEmployeeInput,
} from '../types/index.js';

/**
 * Build the query string for the employee list.
 *
 * Search and filtering are performed SERVER-side by the existing endpoint - the
 * portal never downloads the employee table to filter it in the browser.
 */
function employeeQuery(filters: EmployeeFilters): string {
  const params = new URLSearchParams();
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.rosterType) params.set('roster_type', filters.rosterType);
  if (filters.isActive) params.set('is_active', filters.isActive);
  params.set('page', String(filters.page ?? 1));
  params.set('page_size', String(filters.pageSize ?? 20));
  return params.toString();
}

export const listEmployees = (filters: EmployeeFilters) =>
  api.get<AdminEmployeeList>(`/api/admin/employees?${employeeQuery(filters)}`);

export const createEmployee = (input: CreateEmployeeInput) =>
  api.post<AdminEmployee>('/api/admin/employees', input);

export const updateEmployee = (id: number, input: UpdateEmployeeInput) =>
  api.put<AdminEmployee>(`/api/admin/employees/${id}`, input);

export const setEmployeeStatus = (id: number, isActive: boolean) =>
  api.put<AdminEmployee>(`/api/admin/employees/${id}/status`, { is_active: isActive });

/**
 * Set an employee's password.
 *
 * The plaintext travels only in this request body, over the authenticated HTTPS
 * API - never in a URL, never in a query string. The server hashes it, revokes
 * the employee's sessions, and returns a confirmation containing no credential.
 */
export const setEmployeePassword = (id: number, password: string) =>
  api.put<PasswordSetResult>(`/api/admin/employees/${id}/password`, { password });

export const fetchSettings = () => api.get<Setting[]>('/api/admin/settings');

export const updateCutoff = (cutoffTime: string) =>
  api.put<Setting>('/api/admin/settings/cutoff', { cutoff_time: cutoffTime });

export const listHolidays = () => api.get<Holiday[]>('/api/admin/holidays');

export const addHoliday = (holidayDate: string, name: string) =>
  api.post<Holiday>('/api/admin/holidays', { holiday_date: holidayDate, name });

export const deleteHoliday = (holidayDate: string) =>
  api.del<{ message?: string }>(`/api/admin/holidays/${holidayDate}`);
