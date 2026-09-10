/**
 * Import data hooks.
 *
 * Foundation only: these back a future import UI. No screen consumes them yet,
 * because the employee/roster/menu parsers do not exist and this slice will not
 * ship a workflow that pretends they do.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  commitImport,
  getImport,
  listImports,
  uploadImport,
  validateImport,
} from '../api/importEndpoints.js';
import type { ImportType } from '../types/index.js';

export const IMPORTS_KEY = ['admin', 'imports'] as const;

export function useImports(limit = 20, offset = 0, importType?: ImportType) {
  return useQuery({
    queryKey: [...IMPORTS_KEY, { limit, offset, importType }],
    queryFn: () => listImports(limit, offset, importType),
    retry: false,
  });
}

export function useImport(id: number | null) {
  return useQuery({
    queryKey: [...IMPORTS_KEY, id],
    queryFn: () => getImport(id as number),
    enabled: id !== null,
    retry: false,
  });
}

export function useUploadImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ importType, file }: { importType: ImportType; file: File }) =>
      uploadImport(importType, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IMPORTS_KEY }),
  });
}

export function useValidateImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => validateImport(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IMPORTS_KEY }),
  });
}

export function useCommitImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => commitImport(id),
    // Always refetch: the server owns the resulting state, including whether a
    // concurrent request already committed this batch.
    onSettled: () => queryClient.invalidateQueries({ queryKey: IMPORTS_KEY }),
  });
}
