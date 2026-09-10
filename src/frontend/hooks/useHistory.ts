import { useQuery } from '@tanstack/react-query';
import { fetchHistory } from '../api/endpoints.js';
import type { HistoryPayload } from '../types/index.js';

export function useHistory(limit = 30, offset = 0) {
  return useQuery<HistoryPayload>({
    queryKey: ['history', limit, offset],
    queryFn: () => fetchHistory(limit, offset),
    retry: false,
  });
}
