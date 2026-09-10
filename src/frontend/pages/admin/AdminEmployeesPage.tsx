/**
 * Employee management: list, search, filter, create, edit, activate/deactivate,
 * and set a password.
 *
 * Search and filtering are performed by the SERVER through the existing
 * endpoint's query parameters. The portal never pulls the employee table into
 * the browser to filter it there.
 */

import { useState } from 'react';
import {
  useEmployees,
  useSetEmployeeStatus,
  useDebounced,
} from '../../hooks/useAdmin.js';
import { ApiError } from '../../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { EmployeeFormPanel } from './EmployeeFormPanel.js';
import { PasswordPanel } from './PasswordPanel.js';
import { ROSTER_LABELS } from '../../lib/format.js';
import type { AdminEmployee, EmployeeFilters, RosterType } from '../../types/index.js';

const PAGE_SIZE = 20;

type Panel =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; employee: AdminEmployee }
  | { kind: 'password'; employee: AdminEmployee }
  | { kind: 'status'; employee: AdminEmployee };

export function AdminEmployeesPage() {
  const [search, setSearch] = useState('');
  const [rosterType, setRosterType] = useState<RosterType | ''>('');
  const [isActive, setIsActive] = useState<'true' | 'false' | ''>('');
  const [page, setPage] = useState(1);
  const [panel, setPanel] = useState<Panel>({ kind: 'none' });

  // Debounced so typing does not fire a request per keystroke.
  const debouncedSearch = useDebounced(search, 300);

  const filters: EmployeeFilters = {
    search: debouncedSearch,
    rosterType,
    isActive,
    page,
    pageSize: PAGE_SIZE,
  };

  const { data, isLoading, error, isFetching } = useEmployees(filters);
  const statusMutation = useSetEmployeeStatus();

  const resetToFirstPage = () => setPage(1);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <main className="page">
      <div className="page__head">
        <h1 className="page__title">Employees</h1>
        <button
          type="button"
          className="button button--primary button--inline"
          onClick={() => setPanel({ kind: 'create' })}
        >
          Add employee
        </button>
      </div>

      {panel.kind === 'create' && (
        <EmployeeFormPanel mode="create" onClose={() => setPanel({ kind: 'none' })} />
      )}

      <section className="filters" aria-label="Search and filter employees">
        <label className="field field--inline">
          <span className="field__label">Search</span>
          <input
            className="field__input"
            type="search"
            placeholder="Name, AMCO ID or department"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetToFirstPage();
            }}
          />
        </label>

        <label className="field field--inline field--narrow">
          <span className="field__label">Roster</span>
          <select
            className="field__input"
            value={rosterType}
            onChange={(e) => {
              setRosterType(e.target.value as RosterType | '');
              resetToFirstPage();
            }}
          >
            <option value="">All</option>
            <option value="regular">Regular</option>
            <option value="shift">Shift</option>
            <option value="amman_hq">Amman HQ</option>
          </select>
        </label>

        <label className="field field--inline field--narrow">
          <span className="field__label">Status</span>
          <select
            className="field__input"
            value={isActive}
            onChange={(e) => {
              setIsActive(e.target.value as 'true' | 'false' | '');
              resetToFirstPage();
            }}
          >
            <option value="">All</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </label>
      </section>

      {isLoading && <LoadingState label="Loading employees…" />}

      {error && (
        <ErrorState
          message={
            error instanceof ApiError ? error.message : 'We could not load the employee list.'
          }
        />
      )}

      {data && data.employees.length === 0 && (
        <EmptyState message="No employees match these filters." />
      )}

      {data && data.employees.length > 0 && (
        <>
          <p className="list__count" aria-live="polite">
            {data.total} employee{data.total === 1 ? '' : 's'}
            {isFetching && ' · updating…'}
          </p>

          <ul className="list">
            {data.employees.map((employee) => {
              const active = employee.is_active === true || employee.is_active === 1;

              return (
                <li className="list__item" key={employee.id}>
                  <div className="list__main">
                    <div>
                      <p className="list__title">{employee.full_name}</p>
                      <p className="list__meta">
                        {employee.amco_id}
                        {employee.department && ` · ${employee.department}`}
                        {employee.section && ` · ${employee.section}`}
                      </p>
                    </div>
                    <div className="list__tags">
                      <span className="tag">
                        {ROSTER_LABELS[employee.roster_type] ?? employee.roster_type}
                      </span>
                      <span className={`tag ${active ? 'tag--ok' : 'tag--off'}`}>
                        {active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>

                  <div className="list__actions">
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => setPanel({ kind: 'edit', employee })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => setPanel({ kind: 'password', employee })}
                    >
                      Set password
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => setPanel({ kind: 'status', employee })}
                    >
                      {active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>

                  {panel.kind === 'edit' && panel.employee.id === employee.id && (
                    <EmployeeFormPanel
                      mode="edit"
                      employee={employee}
                      onClose={() => setPanel({ kind: 'none' })}
                    />
                  )}

                  {panel.kind === 'password' && panel.employee.id === employee.id && (
                    <PasswordPanel employee={employee} onClose={() => setPanel({ kind: 'none' })} />
                  )}

                  {panel.kind === 'status' && panel.employee.id === employee.id && (
                    <ConfirmDialog
                      title={active ? 'Deactivate this employee?' : 'Activate this employee?'}
                      detail={
                        active
                          ? `${employee.full_name} (${employee.amco_id}) will no longer be able to sign in, and any active session will end immediately. Their past selections and history are kept.`
                          : `${employee.full_name} (${employee.amco_id}) will be able to sign in again once a password is set.`
                      }
                      confirmLabel={active ? `Deactivate ${employee.amco_id}` : `Activate ${employee.amco_id}`}
                      destructive={active}
                      busy={statusMutation.isPending}
                      onCancel={() => setPanel({ kind: 'none' })}
                      onConfirm={() =>
                        statusMutation.mutate(
                          { id: employee.id, isActive: !active },
                          { onSuccess: () => setPanel({ kind: 'none' }) }
                        )
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>

          {totalPages > 1 && (
            <nav className="pager" aria-label="Pages">
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                Previous
              </button>
              <span className="pager__label">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}

      {statusMutation.isError && (
        <p className="feedback feedback--error" role="alert">
          {statusMutation.error instanceof ApiError
            ? statusMutation.error.message
            : 'The status change could not be saved.'}
        </p>
      )}
    </main>
  );
}
