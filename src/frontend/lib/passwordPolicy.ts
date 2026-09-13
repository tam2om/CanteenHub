/**
 * The password policy the UI shows, kept in step with the server's.
 *
 * The SERVER is the authority: `src/worker/lib/password.ts` validates every
 * password-setting path, and nothing here can let a weak password through. This
 * constant exists so the form can say what the rule is before a round trip, and
 * a test asserts the two numbers agree so they cannot drift apart.
 */
export const MIN_PASSWORD_LENGTH = 5;
