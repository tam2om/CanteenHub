/**
 * Admin data hooks.
 *
 * Every mutation invalidates the queries it affects, so the UI re-reads server
 * state rather than keeping its own authoritative copy. Nothing here caches a
 * password, and no business rule (eligibility, cutoff, business date) is
 * evaluated in the browser.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addHoliday,
  createEmployee,
  deleteHoliday,
  fetchSettings,
  listEmployees,
  listHolidays,
  setEmployeePassword,
  setEmployeeStatus,
  updateCutoff,
  updateEmployee,
} from '../api/adminEndpoints.js';
import type {
  CreateEmployeeInput,
  EmployeeFilters,
  UpdateEmployeeInput,
} from '../types/index.js';

export const ADMIN_EMPLOYEES_KEY = ['admin', 'employees'] as const;
export const ADMIN_SETTINGS_KEY = ['admin', 'settings'] as const;
export const ADMIN_HOLIDAYS_KEY = ['admin', 'holidays'] as const;

/** Server-side search, filter and pagination; the key carries the filters. */
export function useEmployees(filters: EmployeeFilters) {
  return useQuery({
    queryKey: [...ADMIN_EMPLOYEES_KEY, filters],
    queryFn: () => listEmployees(filters),
    retry: false,
    // Keep the previous page visible while the next one loads, so typing in the
    // search box does not blank the table on every keystroke.
    placeholderData: (previous) => previous,
  });
}

export function useCreateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEmployeeInput) => createEmployee(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_EMPLOYEES_KEY }),
  });
}

export function useUpdateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdateEmployeeInput }) =>
      updateEmployee(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_EMPLOYEES_KEY }),
  });
}

export function useSetEmployeeStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      setEmployeeStatus(id, isActive),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_EMPLOYEES_KEY }),
  });
}

/**
 * Set an employee's password.
 *
 * The plaintext is passed straight through to the request and is never written
 * into the query cache: the mutation's cached result is the server's
 * confirmation object, which contains no credential.
 */
export function useSetEmployeePassword() {
  return useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      setEmployeePassword(id, password),
  });
}

export function useSettings() {
  return useQuery({ queryKey: ADMIN_SETTINGS_KEY, queryFn: fetchSettings, retry: false });
}

export function useUpdateCutoff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cutoffTime: string) => updateCutoff(cutoffTime),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_KEY }),
  });
}

export function useHolidays() {
  return useQuery({ queryKey: ADMIN_HOLIDAYS_KEY, queryFn: listHolidays, retry: false });
}

export function useAddHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ date, name }: { date: string; name: string }) => addHoliday(date, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_HOLIDAYS_KEY }),
  });
}

export function useDeleteHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => deleteHoliday(date),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_HOLIDAYS_KEY }),
  });
}

/** Debounce a value so typing in a search box does not fire a request per key. */
export { useDebounced } from './useDebounced.js';
