/**
 * Admin reporting endpoints.
 *
 * No calculation happens on this side. Eligibility, the business date and every
 * count come from the server; the browser only asks and renders.
 */

import { api } from './client.js';
import type { LunchReport } from '../types/index.js';

/** Omitting `date` asks the server which business date "today" is. */
export const getLunchReport = (date?: string) =>
  api.get<LunchReport>(`/api/admin/reports/lunch${date ? `?date=${date}` : ''}`);
