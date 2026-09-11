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

## What Phase 7 actually ran, and what it found

The gap named above was exercised by hand in Phase 7: a real Chromium driven
against a real Worker (`wrangler dev`, `--local-protocol https` so the `Secure`
cookie behaves as it will in production) with a seeded local D1 and R2. **No
browser framework was added to the repository** — the driver script lived
outside it and is not committed, so the finding below is reproducible only by
repeating the exercise, not by `npm test`.

It found the defect this document predicted it would:

> *"The gap a real browser test would still close is the genuine cookie
> round-trip: the component tests stub `fetch`, so `Set-Cookie` handling,
> `SameSite=Strict` behaviour and a true page reload are exercised by neither
> layer."*

`GET /api/auth/me` answered **401 to a perfectly valid session cookie**, because
`sessionMiddleware` was registered after the `/api/auth` router was mounted and
so never ran for it. The SPA restores its session from that endpoint on every
page load, so **every reload, bookmark and typed URL logged the user out**, and
`PUT /api/auth/change-password` — the whole self-service password feature — was
unreachable. The table above records that `portal.test.tsx` covers "session
survives a refresh"; it does, for the UI, given a 200. It never asserted the
server sends one.

Two more defects came from the same session: menu-day action buttons pushed the
document to 2931px inside a 1440px viewport, and import validation died with
"too many SQL variables" at 21 rows. All three are now pinned by
`tests/integration/real-world-acceptance.test.ts`.

Browser checks that passed, at 390px and 1440px: direct navigation and reload of
all ten routes, login and logout, session survival across reload and Back,
`ConfirmDialog` focus/Escape/focus-return, minimum touch-target height, wide
tables inside scroll containers, admin-nav wrapping, and no uncaught JavaScript.

## Recommendation

Add Playwright in a later slice, with **one** focused spec covering the journey
above against `wrangler dev` plus a seeded local D1. One real browser test on the
critical path is worth more than a broad suite, and this repository's container
already ships a Chromium binary, so the remaining work is configuration rather
than installation. Phase 7 is the argument for doing it: three production
blockers sat behind a green 931-test suite, and a browser found all three in an
afternoon.
