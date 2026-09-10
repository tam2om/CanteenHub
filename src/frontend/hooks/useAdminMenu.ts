/**
 * Admin menu management hooks.
 *
 * Every mutation invalidates the month query rather than patching a local
 * cache: the server decides what a menu day looks like after a change, and
 * guessing here is how a screen starts disagreeing with the database.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  archiveMenuDay,
  createMenuDay,
  getMenuMonth,
  publishMenuDay,
  saveMenuComponent,
  saveMenuOption,
} from '../api/menuEndpoints.js';
import type { ComponentType } from '../types/index.js';

export const ADMIN_MENU_KEY = ['admin', 'menu'] as const;

/** `month` undefined means "whichever month the server says it is". */
export function useMenuMonth(month?: string) {
  return useQuery({
    queryKey: [...ADMIN_MENU_KEY, month ?? 'current'],
    queryFn: () => getMenuMonth(month),
    retry: false,
  });
}

function useMenuMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ADMIN_MENU_KEY }),
  });
}

export const useCreateMenuDay = () => useMenuMutation((mealDate: string) => createMenuDay(mealDate));

export const useSaveMenuOption = () =>
  useMenuMutation(
    (args: { menuDayId: number; optionNumber: 1 | 2; name: string; description?: string | null }) =>
      saveMenuOption(args.menuDayId, args.optionNumber, args.name, args.description ?? null)
  );

export const useSaveMenuComponent = () =>
  useMenuMutation(
    (args: {
      menuDayId: number;
      componentType: ComponentType;
      name: string;
      sortOrder?: number;
      componentId?: number;
    }) =>
      saveMenuComponent(
        args.menuDayId,
        args.componentType,
        args.name,
        args.sortOrder ?? 0,
        args.componentId
      )
  );

export const usePublishMenuDay = () => useMenuMutation((menuDayId: number) => publishMenuDay(menuDayId));
export const useArchiveMenuDay = () => useMenuMutation((menuDayId: number) => archiveMenuDay(menuDayId));
