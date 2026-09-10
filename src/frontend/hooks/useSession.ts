/**
 * Session state, derived from the server on every load.
 *
 * There is no client-side "am I logged in" flag to go stale: the answer comes
 * from GET /api/auth/me, which reads the HttpOnly cookie. That is what makes the
 * session survive a refresh without the portal storing anything itself.
 */

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { fetchSession, login as loginRequest, logout as logoutRequest } from '../api/endpoints.js';
import { ApiError } from '../api/client.js';
import type { SessionUser } from '../types/index.js';

export const SESSION_QUERY_KEY = ['session'] as const;

export function useSession() {
  const query = useQuery<SessionUser | null>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      try {
        return await fetchSession();
      } catch (error) {
        // 401 is the normal "not signed in" answer, not a failure to retry.
        if (error instanceof ApiError && error.isUnauthenticated) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 30_000,
  });

  return {
    user: query.data ?? null,
    isAuthenticated: Boolean(query.data),
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ amcoId, password }: { amcoId: string; password: string }) =>
      loginRequest(amcoId, password),
    onSuccess: (data) => {
      // Seed the cache from the login response, then let it revalidate.
      queryClient.setQueryData(SESSION_QUERY_KEY, data.employee);
      queryClient.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => logoutRequest(),
    // Clear the cache either way: if the call failed because the session was
    // already gone, the user still needs to end up signed out.
    onSettled: () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      queryClient.clear();
    },
  });
}
