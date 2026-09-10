/**
 * Admin lunch menu management.
 *
 * Shows a month of lunch menus - drafts included - and lets an administrator
 * review, correct and publish them. This is the screen the Excel import feeds:
 * the importer creates drafts and deliberately never publishes, so a human
 * checks the menu before employees can order from it.
 *
 * NO BUSINESS RULE LIVES HERE. Whether a menu may be published, which
 * component types exist and what a status means are all the server's
 * decisions; this screen renders them and reports what the server says.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useArchiveMenuDay,
  useCreateMenuDay,
  useMenuMonth,
  usePublishMenuDay,
  useSaveMenuComponent,
  useSaveMenuOption,
} from '../../hooks/useAdminMenu.js';
import { ApiError } from '../../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { COMPONENT_TYPES } from '../../types/index.js';
import type { AdminMenuDay, ComponentType } from '../../types/index.js';

/** Readable labels for the schema's internal component_type values. */
const COMPONENT_LABELS: Record<ComponentType, string> = {
  salad: 'Salad',
  soup: 'Soup',
  bread: 'Bread',
  condiment: 'Condiment',
  beverage: 'Beverage',
  dessert: 'Dessert / fruit',
  other: 'Side',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
};

/** Shift a YYYY-MM string by whole months. Calendar arithmetic, no clock. */
function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const zeroBased = (year * 12 + (monthNumber - 1)) + delta;
  return `${String(Math.floor(zeroBased / 12)).padStart(4, '0')}-${String((zeroBased % 12) + 1).padStart(2, '0')}`;
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : error ? fallback : null;

export function AdminMenuPage() {
  // undefined means "ask the server which month it is"; it fills in on load.
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<number | null>(null);
  const [newDate, setNewDate] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const monthQuery = useMenuMonth(month);
  const createMutation = useCreateMenuDay();

  const data = monthQuery.data;
  const currentMonth = data?.month ?? month;

  const handleCreate = () => {
    setCreateError(null);
    if (!newDate) {
      setCreateError('Choose a date first.');
      return;
    }
    createMutation.mutate(newDate, {
      onSuccess: () => setNewDate(''),
    });
  };

  const createFailure = errorMessage(createMutation.error, 'The menu day could not be created.');

  return (
    <main className="page">
      <div className="page__head">
        <h1 className="page__title">Lunch menus</h1>
        <Link to="/admin/imports/menu" className="button button--ghost button--inline button--small">
          Import menu
        </Link>
      </div>

      {/* ---------------- month navigation ---------------- */}
      <section className="card">
        <div className="panel__actions">
          <button
            type="button"
            className="button button--ghost button--inline button--small"
            onClick={() => currentMonth && setMonth(shiftMonth(currentMonth, -1))}
            disabled={!currentMonth}
          >
            ← Previous month
          </button>
          <h2 className="card__title" data-testid="current-month">
            {currentMonth ?? 'Loading…'}
          </h2>
          <button
            type="button"
            className="button button--ghost button--inline button--small"
            onClick={() => currentMonth && setMonth(shiftMonth(currentMonth, 1))}
            disabled={!currentMonth}
          >
            Next month →
          </button>
        </div>
        {data && (
          <p className="panel__note">
            Today is <strong>{data.today}</strong>, as the server reckons it. Employees only ever see
            a menu once it is published.
          </p>
        )}
      </section>

      {/* ---------------- add a day ---------------- */}
      <section className="card">
        <h2 className="card__title">Add a menu day</h2>
        <div className="setting__form">
          <label className="field field--inline">
            <span className="field__label">Date</span>
            <input
              className="field__input"
              type="date"
              value={newDate}
              onChange={(e) => {
                setNewDate(e.target.value);
                setCreateError(null);
              }}
            />
          </label>
          <button
            type="button"
            className="button button--primary button--inline"
            onClick={handleCreate}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? 'Adding…' : 'Add as draft'}
          </button>
        </div>
        <p className="panel__note">
          A new menu day is always a draft. Publishing is a separate, deliberate step.
        </p>
        {(createError || createFailure) && (
          <p className="feedback feedback--error" role="alert">
            {createError ?? createFailure}
          </p>
        )}
      </section>

      {/* ---------------- the month ---------------- */}
      {monthQuery.isLoading && <LoadingState label="Loading menus…" />}
      {monthQuery.error && (
        <ErrorState
          message={
            monthQuery.error instanceof ApiError
              ? monthQuery.error.message
              : 'The menus could not be loaded.'
          }
        />
      )}

      {data && data.menus.length === 0 && (
        <EmptyState message={`No lunch menus for ${data.month} yet.`} />
      )}

      {data &&
        data.menus.map((menu) => (
          <MenuDayCard
            key={menu.id}
            menu={menu}
            isEditing={editing === menu.id}
            onEdit={() => setEditing(menu.id)}
            onCloseEdit={() => setEditing(null)}
          />
        ))}
    </main>
  );
}

// ---------------------------------------------------------------------------

function MenuDayCard({
  menu,
  isEditing,
  onEdit,
  onCloseEdit,
}: {
  menu: AdminMenuDay;
  isEditing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
}) {
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const publishMutation = usePublishMenuDay();
  const archiveMutation = useArchiveMenuDay();

  const option = (n: 1 | 2) => menu.options.find((o) => o.option_number === n) ?? null;

  // Mirrors the server's own rule so the button is not offered when the
  // request would be refused. The server still checks - this is a courtesy,
  // never the authority.
  const incomplete = !option(1)?.name?.trim() || !option(2)?.name?.trim();

  const publishError = errorMessage(publishMutation.error, 'The menu could not be published.');
  const archiveError = errorMessage(archiveMutation.error, 'The menu could not be archived.');

  return (
    <section className="card" data-testid={`menu-day-${menu.meal_date}`}>
      <div className="list__main">
        <div>
          <h2 className="card__title">{menu.meal_date}</h2>
          <p className="list__meta">
            {menu.status === 'published'
              ? 'Employees can see and select this menu.'
              : menu.status === 'draft'
                ? 'Not visible to employees.'
                : 'Archived — not offered to employees.'}
          </p>
        </div>
        <span
          className={`tag ${
            menu.status === 'published' ? 'tag--ok' : menu.status === 'archived' ? 'tag--off' : ''
          }`}
        >
          {STATUS_LABELS[menu.status] ?? menu.status}
        </span>
      </div>

      <ul className="list list--tight">
        <li className="list__item">
          <p className="list__title">Option 1</p>
          <p className="list__meta">{option(1)?.name || '— not set —'}</p>
        </li>
        <li className="list__item">
          <p className="list__title">Option 2</p>
          <p className="list__meta">{option(2)?.name || '— not set —'}</p>
        </li>
      </ul>

      {menu.components.length > 0 && (
        <ul className="changes">
          {menu.components.map((component) => (
            <li key={component.id}>
              <span className="changes__field">
                {COMPONENT_LABELS[component.component_type] ?? component.component_type}
              </span>
              <span className="changes__to">{component.name}</span>
            </li>
          ))}
        </ul>
      )}

      {incomplete && (
        <p className="panel__note">
          This menu needs both options before it can be published.
        </p>
      )}

      {(publishError || archiveError) && (
        <p className="feedback feedback--error" role="alert">
          {publishError ?? archiveError}
        </p>
      )}

      {isEditing ? (
        <MenuDayEditor menu={menu} onClose={onCloseEdit} />
      ) : confirmingPublish ? (
        <ConfirmDialog
          title={`Publish the menu for ${menu.meal_date}?`}
          detail={
            `Option 1: ${option(1)?.name ?? '—'}. Option 2: ${option(2)?.name ?? '—'}. ` +
            'Once published, eligible employees can see this menu and select from it. ' +
            'Existing selections are never changed by publishing.'
          }
          confirmLabel="Publish menu"
          busy={publishMutation.isPending}
          onCancel={() => setConfirmingPublish(false)}
          onConfirm={() =>
            publishMutation.mutate(menu.id, {
              onSettled: () => setConfirmingPublish(false),
            })
          }
        />
      ) : confirmingArchive ? (
        <ConfirmDialog
          title={`Archive the menu for ${menu.meal_date}?`}
          detail={
            'An archived menu is no longer offered to employees. Selections already made are ' +
            'kept and are not deleted.'
          }
          confirmLabel="Archive menu"
          destructive
          busy={archiveMutation.isPending}
          onCancel={() => setConfirmingArchive(false)}
          onConfirm={() =>
            archiveMutation.mutate(menu.id, {
              onSettled: () => setConfirmingArchive(false),
            })
          }
        />
      ) : (
        <div className="panel__actions">
          <button type="button" className="button button--ghost" onClick={onEdit}>
            Edit
          </button>
          {menu.status !== 'archived' && (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setConfirmingArchive(true)}
            >
              Archive
            </button>
          )}
          {menu.status !== 'published' && (
            <button
              type="button"
              className="button button--primary"
              onClick={() => setConfirmingPublish(true)}
              disabled={incomplete}
            >
              Publish
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

/**
 * Editing a menu day.
 *
 * Saving writes a DRAFT edit: it changes the menu's content and never its
 * status. A published menu edited here stays published - taking a live menu
 * off the employees' screens is a deliberate archive, not a side effect of
 * fixing a typo.
 */
function MenuDayEditor({ menu, onClose }: { menu: AdminMenuDay; onClose: () => void }) {
  const optionValue = (n: 1 | 2) => menu.options.find((o) => o.option_number === n)?.name ?? '';

  const [option1, setOption1] = useState(optionValue(1));
  const [option2, setOption2] = useState(optionValue(2));
  const [componentType, setComponentType] = useState<ComponentType>('salad');
  const [componentName, setComponentName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const saveOption = useSaveMenuOption();
  const saveComponent = useSaveMenuComponent();

  const saveError =
    errorMessage(saveOption.error, 'The option could not be saved.') ??
    errorMessage(saveComponent.error, 'The component could not be saved.');

  const handleSave = async () => {
    setFormError(null);
    if (!option1.trim() || !option2.trim()) {
      setFormError('Both options need a name. Save what you have once they are filled in.');
      return;
    }

    await saveOption.mutateAsync({ menuDayId: menu.id, optionNumber: 1, name: option1.trim() });
    await saveOption.mutateAsync({ menuDayId: menu.id, optionNumber: 2, name: option2.trim() });

    if (componentName.trim()) {
      const existing = menu.components.find((c) => c.component_type === componentType);
      await saveComponent.mutateAsync({
        menuDayId: menu.id,
        componentType,
        name: componentName.trim(),
        sortOrder: existing?.sort_order ?? menu.components.length,
        componentId: existing?.id,
      });
      setComponentName('');
    }

    onClose();
  };

  const busy = saveOption.isPending || saveComponent.isPending;

  return (
    <div className="setting__form">
      <label className="field">
        <span className="field__label">Option 1</span>
        <input
          className="field__input"
          type="text"
          value={option1}
          onChange={(e) => setOption1(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field__label">Option 2</span>
        <input
          className="field__input"
          type="text"
          value={option2}
          onChange={(e) => setOption2(e.target.value)}
        />
      </label>

      <label className="field field--inline">
        <span className="field__label">Component</span>
        <select
          className="field__input"
          value={componentType}
          onChange={(e) => setComponentType(e.target.value as ComponentType)}
        >
          {COMPONENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {COMPONENT_LABELS[type]}
            </option>
          ))}
        </select>
      </label>
      <label className="field field--inline">
        <span className="field__label">Component name</span>
        <input
          className="field__input"
          type="text"
          value={componentName}
          onChange={(e) => setComponentName(e.target.value)}
          placeholder="Leave blank to change nothing"
        />
      </label>

      {(formError || saveError) && (
        <p className="feedback feedback--error" role="alert">
          {formError ?? saveError}
        </p>
      )}

      <p className="panel__note">
        Saving changes the menu content only. It never publishes, and it never unpublishes a menu
        that is already live.
      </p>

      <div className="panel__actions">
        <button type="button" className="button button--ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={handleSave}
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save draft changes'}
        </button>
      </div>
    </div>
  );
}
