/**
 * Import API wrappers.
 *
 * Uses the same authenticated client as everything else (HttpOnly session
 * cookie). The upload is multipart, so it bypasses the JSON helper and sets no
 * Content-Type - the browser must supply the multipart boundary itself.
 */

import { api, ApiError } from './client.js';
import type { ImportDetail, ImportList, ImportType } from '../types/index.js';

export const listImports = (limit = 20, offset = 0, importType?: ImportType) => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (importType) params.set('import_type', importType);
  return api.get<ImportList>(`/api/admin/imports?${params.toString()}`);
};

export const getImport = (id: number) => api.get<ImportDetail>(`/api/admin/imports/${id}`);

export const validateImport = (id: number) =>
  api.post<ImportDetail>(`/api/admin/imports/${id}/validate`, {});

export const commitImport = (id: number) =>
  api.post<ImportDetail>(`/api/admin/imports/${id}/commit`, {});

/**
 * Upload a workbook, opening a new import batch.
 *
 * Deliberately hand-rolled rather than routed through `api.post`: that helper
 * sets `Content-Type: application/json`, which would corrupt a multipart body.
 */
export async function uploadImport(importType: ImportType, file: File): Promise<ImportDetail> {
  const form = new FormData();
  form.set('import_type', importType);
  form.set('file', file);

  const response = await fetch('/api/admin/imports', {
    method: 'POST',
    credentials: 'include',
    body: form,
  });

  let body: { success?: boolean; data?: unknown; error?: string } | null = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || body?.success === false) {
    throw new ApiError(
      response.status,
      body?.error ?? `Upload failed (${response.status})`,
      body
    );
  }

  return body?.data as ImportDetail;
}
