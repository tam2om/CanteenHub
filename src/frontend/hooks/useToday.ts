/**
 * Today's dashboard data and the selection mutation.
 *
 * Every rule - business date, eligibility, cutoff - is decided by the server and
 * simply rendered here. The portal deliberately contains no eligibility or
 * cutoff logic to drift out of sync with the backend.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchToday, submitSelection } from '../api/endpoints.js';
import type { LunchChoice, TodayPayload } from '../types/index.js';

export const TODAY_QUERY_KEY = ['today'] as const;

export function useToday(date?: string) {
  return useQuery<TodayPayload>({
    queryKey: [...TODAY_QUERY_KEY, date ?? 'current'],
    queryFn: () => fetchToday(date),
    retry: false,
  });
}

export function useSelectMeal(mealDate: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (choice: LunchChoice) => submitSelection(mealDate, choice),
    // Refetch rather than patching the cache by hand: the server owns the
    // resulting state, including whether the write was a no-op.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TODAY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
