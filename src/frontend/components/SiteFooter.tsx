/**
 * The footer on every screen: who built this, and that it is internal.
 *
 * One component rendered by all three layouts - the sign-in page, the
 * employee portal and the admin area - so the wording can never drift between
 * them, and a new layout picks it up by rendering one element.
 */

export const FOOTER_CREDIT =
  'Developed in-house by the AMCO Information Technology Department, 2026.';
export const FOOTER_NOTICE = 'This website is intended for internal use only.';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p className="site-footer__line">{FOOTER_CREDIT}</p>
      <p className="site-footer__line">{FOOTER_NOTICE}</p>
    </footer>
  );
}
