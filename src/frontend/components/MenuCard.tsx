/**
 * Today's published menu. Shows an explicit empty state rather than inventing
 * data when nothing is published.
 */

import type { Menu } from '../types/index.js';

export function MenuCard({ menu }: { menu: Menu | null }) {
  if (!menu) {
    return (
      <section className="card">
        <h2 className="card__title">Today&rsquo;s menu</h2>
        <p className="empty">Today&rsquo;s lunch menu is not available.</p>
      </section>
    );
  }

  const option1 = menu.options.find((o) => o.option_number === 1);
  const option2 = menu.options.find((o) => o.option_number === 2);

  return (
    <section className="card">
      <h2 className="card__title">Today&rsquo;s menu</h2>

      <dl className="menu">
        {[option1, option2].map((option, index) =>
          option ? (
            <div className="menu__row" key={option.id}>
              <dt className="menu__label">Option {index + 1}</dt>
              <dd className="menu__value">
                {option.name}
                {option.description && <span className="menu__desc">{option.description}</span>}
              </dd>
            </div>
          ) : null
        )}
      </dl>

      {menu.components.length > 0 && (
        <div className="menu__extras">
          <h3 className="menu__extras-title">Served with</h3>
          <ul className="menu__extras-list">
            {menu.components.map((component) => (
              <li key={component.id}>
                <span className="menu__extras-type">{component.component_type}</span>
                {component.name}
              </li>
            ))}
          </ul>
          <p className="menu__extras-note">
            These are served with either option and are not a separate choice.
          </p>
        </div>
      )}
    </section>
  );
}
