/** Admin reporting hooks. Read-only: reports mutate nothing. */

import { useQuery } from '@tanstack/react-query';
import { getLunchReport } from '../api/reportEndpoints.js';

export const REPORTS_KEY = ['admin', 'reports'] as const;

export function useLunchReport(date?: string) {
  return useQuery({
    queryKey: [...REPORTS_KEY, 'lunch', date ?? 'today'],
    queryFn: () => getLunchReport(date),
    retry: false,
  });
}
