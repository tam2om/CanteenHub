# Browser (E2E) testing — status

**No browser test framework is configured in this repository.** There is no
Playwright or Cypress config and no browser-test dependency in `package.json`.

Phase 3 Slice 2 deliberately did **not** add one. Standing up browser
infrastructure (runner, browser binaries, CI wiring, a dev-server harness) is a
slice of work in itself, and the instruction for this slice was to document the
gap rather than spend the slice building a testing platform.

## What covers the critical path instead

The journey an E2E test would walk — login → dashboard → menu → select → confirm
→ refresh → selection persists — is currently covered from both ends:

| Step | Covered by |
|---|---|
| Login success / failure | `tests/frontend/portal.test.tsx` (real form, real hooks, stubbed `fetch`) |
| Session survives a refresh | `tests/frontend/portal.test.tsx` — the component tree is unmounted and remounted with an empty cache, which is what a reload does; the session is re-established from the cookie via `GET /api/auth/me` |
| Dashboard renders server data | `tests/frontend/portal.test.tsx` |
| Menu published / unpublished / absent | `tests/frontend/portal.test.tsx` + `tests/integration/me-portal.test.ts` |
| Selection saved, changed, no-op | `tests/frontend/portal.test.tsx` (UI) + `tests/integration/selections.test.ts` (server truth) |
| Selection persists after reload | `tests/integration/me-portal.test.ts` — `GET /api/me/today` returns the stored selection |
| Cutoff / eligibility refusals | `tests/integration/me-portal.test.ts` + `tests/frontend/portal.test.tsx` |

The gap a real browser test would still close is the genuine cookie round-trip:
the component tests stub `fetch`, so `Set-Cookie` handling, `SameSite=Strict`
behaviour and a true page reload are exercised by neither layer.

## Recommendation

Add Playwright in a later slice, with **one** focused spec covering the journey
above against `wrangler dev` plus a seeded local D1. One real browser test on the
critical path is worth more than a broad suite, and this repository's container
already ships a Chromium binary, so the remaining work is configuration rather
than installation.
