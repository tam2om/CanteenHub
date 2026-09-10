/**
 * Frontend test helpers.
 *
 * Components are rendered against a real QueryClient and a real router, with
 * only `fetch` stubbed. That keeps the tests exercising the actual hooks,
 * routing and API client rather than a mock of them.
 */

import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { TodayPayload } from '../../src/frontend/types/index.js';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: ReactElement,
  { route = '/' }: { route?: string } = {}
) {
  const queryClient = createTestQueryClient();

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );

  return { ...render(ui, { wrapper: Wrapper }), queryClient };
}

type RouteMap = Record<string, { status?: number; body: unknown }>;

/**
 * Stub fetch with a path -> response map. Any unmapped path returns 404, so a
 * test can never accidentally pass because of a silently-successful call.
 */
export function stubFetch(
  routes: RouteMap,
  { delayPaths = [] as string[] }: { delayPaths?: string[] } = {}
) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.split('?')[0];
    const match = routes[url] ?? routes[path];

    if (!match) {
      return new Response(JSON.stringify({ success: false, error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Hold a response open so a test can observe the in-flight (loading) state.
    if (delayPaths.includes(path) || delayPaths.includes(url)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const status = match.status ?? 200;
    return new Response(JSON.stringify(match.body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  vi.stubGlobal('fetch', impl);
  return impl;
}

export const SESSION_USER = {
  id: 1,
  amco_id: 'TEST001',
  full_name: 'Portal Tester',
  department: 'Mining',
  section: 'Operations',
  roster_type: 'regular' as const,
  role: 'employee',
};

/** A complete, eligible /api/me/today payload; override per test. */
export function todayPayload(overrides: Partial<TodayPayload> = {}): TodayPayload {
  return {
    businessDate: '2027-03-07',
    mealDate: '2027-03-07',
    employee: {
      id: 1,
      amco_id: 'TEST001',
      full_name: 'Portal Tester',
      department: 'Mining',
      section: 'Operations',
      roster_type: 'regular',
      is_active: 1,
    },
    eligibility: {
      eligible: true,
      reason: 'REGULAR_WORKING_DAY',
      rosterType: 'regular',
      nextEligibleDate: null,
    },
    menu: {
      id: 10,
      meal_date: '2027-03-07',
      status: 'published',
      options: [
        { id: 1, option_number: 1, name: 'Test Dish Alpha', description: null },
        { id: 2, option_number: 2, name: 'Test Dish Beta', description: null },
      ],
      components: [{ id: 5, component_type: 'beverage', name: 'Test Beverage' }],
    },
    selection: null,
    cutoffPassed: false,
    canSelect: true,
    ...overrides,
  };
}

export const ok = (data: unknown) => ({ body: { success: true, data } });
export const fail = (status: number, error: string) => ({
  status,
  body: { success: false, error },
});
