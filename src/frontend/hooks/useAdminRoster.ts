/**
 * Admin roster hooks.
 *
 * Every mutation invalidates the day query rather than patching a local cache:
 * the server decides what the roster looks like after a change, and guessing
 * here is how a screen starts disagreeing with the database.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRosterDay, removeRosterEntry, setRosterEntry } from '../api/rosterEndpoints.js';
import type { ShiftValue } from '../types/index.js';

export const ADMIN_ROSTER_KEY = ['admin', 'roster'] as const;

export function useRosterDay(params: { date?: string; search?: string; rosterType?: string }) {
  return useQuery({
    queryKey: [...ADMIN_ROSTER_KEY, params.date ?? 'today', params.search ?? '', params.rosterType ?? ''],
    queryFn: () => getRosterDay(params),
    retry: false,
  });
}

function useRosterMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ADMIN_ROSTER_KEY }),
  });
}

export const useSetRosterEntry = () =>
  useRosterMutation((args: { employeeId: number; workDate: string; shiftValue: ShiftValue }) =>
    setRosterEntry(args.employeeId, args.workDate, args.shiftValue)
  );

export const useRemoveRosterEntry = () =>
  useRosterMutation((args: { employeeId: number; workDate: string }) =>
    removeRosterEntry(args.employeeId, args.workDate)
  );
