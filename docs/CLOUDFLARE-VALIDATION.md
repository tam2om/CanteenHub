# Temporary Cloudflare validation — results

Ran against `main` at `3e9fe3d` on 2026-09-13, using **throwaway resources that
were deleted afterwards**. This is the evidence that turned the Phase 8
"INFERRED" capabilities into observed facts.

## What this is, and what it is not

| | |
|---|---|
| **Local validation** | Phases 7–8: `wrangler dev`, miniflare D1, a real browser. Still valid, still recorded in `PHASE7-ACCEPTANCE.md` and `PHASE8-RELEASE-AUDIT.md` |
| **Temporary Cloudflare validation** | **This document.** A real Worker on Cloudflare's edge, a real D1 database, real migrations, a real Time Travel restore — on resources named `canteenhub-validation`, since deleted |
| **Production validation** | **Still not done.** No `canteenhub-prod` Worker or database has ever been created. Nothing here says otherwise |

## Resources used (all deleted after the run)

| | |
|---|---|
| Account | `eb0f072a834aaac5311c5d885830903c` |
| Worker | `canteenhub-validation`, version `8d8a676a-f040-442a-8ed1-0c1f72bd9d01` |
| URL | `https://canteenhub-validation.tamer-haj.workers.dev` |
| D1 | `canteenhub-validation`, `030d80dd-2782-4705-b314-0a3797e7dc65`, region ENAM |
| Bindings | `DB` (D1) and `ASSETS` only — no R2, KV, Durable Object or Queue |
| Migrations applied | `0001_initial_schema.sql`, `0002_holidays.sql`, `0003_import_foundation.sql` → 16 tables, 31 indexes |

## Results

**Infrastructure.** `/api/health` reported `database: connected` from the edge —
D1 connectivity proven through the deployed Worker, not inferred. All ten deep
links (`/login`, `/admin`, `/admin/employees`, `/admin/menu`, `/admin/roster`,
`/admin/reports`, `/admin/imports`, `/admin/settings`, `/history`, `/profile`)
returned `200 text/html`, while `/api/definitely-not-real` stayed
`404 application/json`. Static assets and the favicon served correctly.

**Authentication.** Login, `/api/auth/me`, logout and post-logout cookie
rejection all behaved. Cookie flags on the real HTTPS deployment:
`Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`. Security headers
present: HSTS, `nosniff`, `SAMEORIGIN`, `no-referrer`. `/api/auth/me` returned
no field matching password, hash or token.

**Imports.** Employee, roster and menu workbooks all ran
upload → validate → preview → commit against the deployed Worker. Re-importing
the same roster reported *"0 new, 0 changed, 60 already correct"*. Invalid
workbooks landed in `validation_failed` and their commit was refused with 409.
No response carried `file_archived` or `r2_object_key`.

**Business rules.** On Sunday 2026-09-13: `REGULAR_WORKING_DAY` eligible,
`SHIFT_OFF` and `AMMAN_HQ_NO_MEAL` refused, an Amman HQ selection rejected by
the server. A draft menu 404'd for an employee and became visible only after an
explicit publish — exactly two options, five component types.

**Cutoff — tested against the real configured value first.** Amman time was
10:50 against the configured 10:00 and the selection was refused with
*"Selection cutoff time has passed"*. Timezone-correct cutoff, observed on a
real deployment rather than reasoned about.

**Selection and history.** option_1 → option_2 → option_2 (no-op,
`changed: false`) → no_preference produced **exactly 3** history rows.

**Reporting.** Counts matched reality, including `eligible_not_selected` and a
per-reason breakdown covering `REGULAR_WORKING_DAY`, `SHIFT_DAY`, `SHIFT_OFF`,
`AMMAN_HQ_NO_MEAL` and `EMPLOYEE_INACTIVE`.

**Authorization.** Seven admin endpoints returned `admin=200 employee=403
anon=401`. An employee reading another employee got 403. Password-set returned
only `{password_set, sessionsRevoked}`. The employee listing contained zero
secret-shaped fields. A SQL-shaped search returned an empty result set. A
malformed JSON body returned `Internal Server Error` — production error opacity
confirmed on a real deployment.

**Cron.** Read back from Cloudflare, not from the file: the deployed Worker
carries `17 3 * * *`, created `2026-09-13T07:46:46Z`.

### D1 Time Travel — the headline result

Performed **only** on `canteenhub-validation`.

1. `wrangler d1 time-travel info` returned bookmark
   `00000000-000000cd-000050e5-c9f1e5438d142946ddd59fa198b1cffe`.
2. State at that bookmark: employees 6, roster 60, menu_days 30,
   menu_options 60, menu_components 134, selections 1, history 3, holidays 1,
   audit 22, batches 6, batch_rows 43, migrations 3.
3. A controlled destructive change deleted roster, menus, options, components,
   selections, history and holidays. Damage confirmed — all seven at **0**, and
   the live app returned 404 for the day's menu.
4. `wrangler d1 time-travel restore --bookmark=…` reported
   *"✅ Database canteenhub-validation restored back to bookmark …"* and offered
   an undo bookmark.
5. **Every count returned to its pre-damage value exactly.** 16 tables intact;
   `migrations list` reported *"No migrations to apply"*, so the ledger survived.
6. The live application then worked against the restored database: both logins,
   the published menu, the restored selection, 3 history entries, and the admin
   report all correct.

Time Travel is no longer "documented but untested". It is tested — on a
throwaway database, which is how `RECOVERY.md` always said to rehearse it.

### Free-tier footprint

`d1 info` after the entire run: **344 kB** database, 9,224 rows read and 2,614
rows written in 24h — against free-plan ceilings of 500 MB, 5 M reads/day and
100 k writes/day. Deployed-endpoint latency 0.22–0.47 s including the round trip
from this container. No paid service was created or used.

## What this run did NOT establish

- **Production is still unvalidated.** No `canteenhub-prod` Worker or D1 exists.
- **Login rate limiting could not be exercised here.** The limiter keys on
  `<client IP>:<AMCO ID>`, and this environment egresses through a proxy that
  rotates source IPs — eight failed attempts landed in five different buckets,
  so no bucket reached the threshold of five. Not a defect, and the logic is
  covered by seven regression tests plus a local `wrangler dev` run where every
  request came from one address. It remains **unproven on a real deployment**.
- **The cron handler was not observed firing.** Cloudflare offers no supported
  way to trigger a scheduled Worker on demand; only its registration was read
  back. The handler's behaviour was proven locally via `--test-scheduled`.
- **The real September lunch menu XLSX is still unvalidated.** The fixture used
  here is sanitized and synthetic. The real menu remains PDF-only.
