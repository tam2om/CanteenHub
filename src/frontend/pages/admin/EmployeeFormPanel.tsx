/**
 * Create / edit employee.
 *
 * Client validation is a convenience only. The server re-validates everything
 * and remains authoritative; when it refuses, its own message is what the
 * administrator sees, so the two can never tell different stories.
 */

import { useState, type FormEvent } from 'react';
import { useCreateEmployee, useUpdateEmployee } from '../../hooks/useAdmin.js';
import { ApiError } from '../../api/client.js';
import type {
  AdminEmployee,
  CreateEmployeeInput,
  RosterType,
  UpdateEmployeeInput,
} from '../../types/index.js';

interface Props {
  mode: 'create' | 'edit';
  employee?: AdminEmployee;
  onClose: () => void;
}

const ROSTER_OPTIONS: Array<{ value: RosterType; label: string }> = [
  { value: 'regular', label: 'Regular (Sunday–Thursday)' },
  { value: 'shift', label: 'Shift (follows daily roster)' },
  { value: 'amman_hq', label: 'Amman HQ (no company meal)' },
];

export function EmployeeFormPanel({ mode, employee, onClose }: Props) {
  const isEdit = mode === 'edit';

  const [amcoId, setAmcoId] = useState(employee?.amco_id ?? '');
  const [fullName, setFullName] = useState(employee?.full_name ?? '');
  const [department, setDepartment] = useState(employee?.department ?? '');
  const [section, setSection] = useState(employee?.section ?? '');
  const [rosterType, setRosterType] = useState<RosterType>(employee?.roster_type ?? 'regular');
  const [clientError, setClientError] = useState<string | null>(null);

  const create = useCreateEmployee();
  const update = useUpdateEmployee();
  const mutation = isEdit ? update : create;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setClientError(null);

    if (!isEdit && !amcoId.trim()) {
      setClientError('AMCO ID is required.');
      return;
    }
    if (!fullName.trim()) {
      setClientError('Name is required.');
      return;
    }

    if (isEdit && employee) {
      // Only the fields this form owns are sent. Anything it does not manage -
      // is_active, role_id, password - is left untouched rather than being
      // resubmitted with a stale value.
      const input: UpdateEmployeeInput = {
        full_name: fullName.trim(),
        department: department.trim() || null,
        section: section.trim() || null,
        roster_type: rosterType,
      };
      update.mutate({ id: employee.id, input }, { onSuccess: onClose });
      return;
    }

    const input: CreateEmployeeInput = {
      amco_id: amcoId.trim(),
      full_name: fullName.trim(),
      department: department.trim() || null,
      section: section.trim() || null,
      roster_type: rosterType,
    };
    create.mutate(input, { onSuccess: onClose });
  };

  const serverError =
    mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? 'The employee could not be saved.'
        : null;

  return (
    <section className="panel" aria-label={isEdit ? 'Edit employee' : 'Add employee'}>
      <h2 className="panel__title">{isEdit ? `Edit ${employee?.amco_id}` : 'Add employee'}</h2>

      <form onSubmit={handleSubmit} noValidate>
        {!isEdit && (
          <label className="field">
            <span className="field__label">AMCO ID</span>
            <input
              className="field__input"
              name="amco_id"
              value={amcoId}
              onChange={(e) => setAmcoId(e.target.value)}
              autoCapitalize="characters"
            />
          </label>
        )}

        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="field__input"
            name="full_name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Department</span>
          <input
            className="field__input"
            name="department"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Section</span>
          <input
            className="field__input"
            name="section"
            value={section}
            onChange={(e) => setSection(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Roster type</span>
          <select
            className="field__input"
            name="roster_type"
            value={rosterType}
            onChange={(e) => setRosterType(e.target.value as RosterType)}
          >
            {ROSTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {(clientError || serverError) && (
          <p className="feedback feedback--error" role="alert">
            {clientError ?? serverError}
          </p>
        )}

        {!isEdit && (
          <p className="panel__note">
            The new employee cannot sign in until you set a password for them.
          </p>
        )}

        <div className="panel__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create employee'}
          </button>
        </div>
      </form>
    </section>
  );
}
