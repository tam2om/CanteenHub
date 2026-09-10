/**
 * Admin menu management endpoints.
 *
 * Thin wrappers over the existing /api/menu routes. No business rule lives
 * here: what may be published, which component types exist and what a menu
 * day's status means are all decided server-side.
 */

import { api } from './client.js';
import type { AdminMenuDay, AdminMenuMonth, ComponentType } from '../types/index.js';

/**
 * A month of menu days, drafts included.
 *
 * `month` is optional: omitting it asks the server which month "now" is, so
 * the browser's clock never decides.
 */
export const getMenuMonth = (month?: string) =>
  api.get<AdminMenuMonth>(`/api/menu/admin/range${month ? `?month=${month}` : ''}`);

/** Create a menu day. Always a draft - status is not settable here. */
export const createMenuDay = (mealDate: string) =>
  api.post<AdminMenuDay>('/api/menu', { meal_date: mealDate });

export const saveMenuOption = (
  menuDayId: number,
  optionNumber: 1 | 2,
  name: string,
  description: string | null = null
) =>
  api.post<unknown>(`/api/menu/${menuDayId}/options`, {
    option_number: optionNumber,
    name,
    description,
  });

/** Passing `componentId` edits that component; omitting it creates a new one. */
export const saveMenuComponent = (
  menuDayId: number,
  componentType: ComponentType,
  name: string,
  sortOrder = 0,
  componentId?: number
) =>
  api.post<unknown>(`/api/menu/${menuDayId}/components`, {
    component_type: componentType,
    name,
    sort_order: sortOrder,
    ...(componentId ? { component_id: componentId } : {}),
  });

export const publishMenuDay = (menuDayId: number) =>
  api.put<AdminMenuDay>(`/api/menu/${menuDayId}/publish`, {});

export const archiveMenuDay = (menuDayId: number) =>
  api.put<AdminMenuDay>(`/api/menu/${menuDayId}/archive`, {});
