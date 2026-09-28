/**
 * Today's dashboard data and the selection mutation.
 *
 * Every rule - business date, eligibility, cutoff - is decided by the server and
 * simply rendered here. The portal deliberately contains no eligibility or
 * cutoff logic to drift out of sync with the backend.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchToday, submitSelection } from '../api/endpoints.js';
import type { MealLocation } from '../types/index.js';
import type { LunchChoice, TodayPayload } from '../types/index.js';

export const TODAY_QUERY_KEY = ['today'] as const;

export function useToday(date?: string) {
  return useQuery<TodayPayload>({
    queryKey: [...TODAY_QUERY_KEY, date ?? 'current'],
    queryFn: () => fetchToday(date),
    retry: false,
  });
}

/**
 * Submit a meal choice.
 *
 * `pickupLocation` is REQUIRED. The server refuses a selection without one -
 * a portion has to be sent to a particular canteen - so the mutation will not
 * let a caller omit it and discover that at runtime.
 */
export function useSelectMeal(mealDate: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { choice: LunchChoice; pickupLocation: MealLocation }) =>
      submitSelection(mealDate, input.choice, input.pickupLocation),
    // Refetch rather than patching the cache by hand: the server owns the
    // resulting state, including whether the write was a no-op.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TODAY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
