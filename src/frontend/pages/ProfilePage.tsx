/**
 * Profile - safe fields only.
 *
 * Everything shown comes from GET /api/me/today, which serialises the employee
 * through the same sanitiser the admin routes use, so no credential or internal
 * security field can reach this screen.
 */

import { useToday } from '../hooks/useToday.js';
import { ApiError } from '../api/client.js';
import { ErrorState, LoadingState } from '../components/States.js';
import { ROSTER_LABELS } from '../lib/format.js';

export function ProfilePage() {
  const { data, isLoading, error } = useToday();

  if (isLoading) return <LoadingState label="Loading your profile…" />;
  if (error) {
    return (
      <ErrorState
        message={error instanceof ApiError ? error.message : 'We could not load your profile.'}
      />
    );
  }
  if (!data) return <ErrorState message="No profile data was returned." />;

  const { employee } = data;
  const isActive = employee.is_active === true || employee.is_active === 1;

  const rows: Array<[string, string]> = [
    ['Name', employee.full_name],
    ['AMCO ID', employee.amco_id],
    ['Department', employee.department ?? '—'],
    ['Section', employee.section ?? '—'],
    ['Roster type', ROSTER_LABELS[employee.roster_type] ?? employee.roster_type],
    ['Account status', isActive ? 'Active' : 'Inactive'],
  ];

  return (
    <main className="page">
      <h1 className="page__title">Your profile</h1>

      <dl className="profile">
        {rows.map(([label, value]) => (
          <div className="profile__row" key={label}>
            <dt className="profile__label">{label}</dt>
            <dd className="profile__value">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="profile__note">
        To correct any of these details, or to have your password changed, contact the canteen
        administrator.
      </p>
    </main>
  );
}
