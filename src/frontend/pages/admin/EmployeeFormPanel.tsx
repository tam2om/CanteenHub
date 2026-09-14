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
import { useSession } from '../../hooks/useSession.js';
import type {
  AdminEmployee,
  CreateEmployeeInput,
  MealLocation,
  RosterType,
  UpdateEmployeeInput,
} from '../../types/index.js';
import {
  DEFAULT_MEAL_LOCATION,
  MEAL_LOCATIONS,
  MEAL_LOCATION_LABELS,
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
  const [location, setLocation] = useState<MealLocation>(
    employee?.default_location ?? DEFAULT_MEAL_LOCATION
  );
  const [roleId, setRoleId] = useState<number>(employee?.role_id ?? 1);
  const { user } = useSession();
  const isSuperAdmin = user?.role === 'super_admin';
  const [clientError, setClientError] = useState<string | null>(null);

  const create = useCreateEmployee();
  const update = useUpdateEmployee();
  const mutation = isEdit ? update : create;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setClientError(null);

    if (!isEdit && !amcoId.trim()) {
      setClientError('ID is required.');
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
        default_location: location,
        // Sent only when it actually changes, so an administrator editing a
        // name never re-asserts a role - and the server's super-administrator
        // guard is never triggered by an edit that was not about roles.
        ...(roleId !== (employee.role_id ?? 1) ? { role_id: roleId } : {}),
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
      default_location: location,
      ...(roleId !== 1 ? { role_id: roleId } : {}),
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
            <span className="field__label">ID</span>
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

        <label className="field">
          <span className="field__label">Default canteen</span>
          <select
            className="field__input"
            name="default_location"
            value={location}
            onChange={(e) => setLocation(e.target.value as MealLocation)}
          >
            {MEAL_LOCATIONS.map((value) => (
              <option key={value} value={value}>
                {MEAL_LOCATION_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        {/* Role. The super administrator option is offered only to a super
            administrator - and the SERVER refuses it regardless of what this
            form sends, which is what actually enforces the rule. */}
        <label className="field">
          <span className="field__label">Role</span>
          <select
            className="field__input"
            name="role_id"
            value={roleId}
            onChange={(e) => setRoleId(Number(e.target.value))}
          >
            <option value={1}>Employee</option>
            <option value={2}>Administrator</option>
            {(isSuperAdmin || roleId === 3) && <option value={3}>Super administrator</option>}
          </select>
          {!isSuperAdmin && (
            <span className="field__hint">
              Only a super administrator can grant the super administrator role.
            </span>
          )}
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
