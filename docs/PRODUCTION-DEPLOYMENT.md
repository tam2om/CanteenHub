# CanteenHub — production deployment record

Deployed 2026-09-13 from `main` at `3e9fe3d`. This is the first time CanteenHub
has existed on Cloudflare as a production system.

## The three levels of validation, kept distinct

| Level | What it means | Where |
|---|---|---|
| **Local** | `wrangler dev`, miniflare D1, a real browser | `PHASE7-ACCEPTANCE.md`, `PHASE8-RELEASE-AUDIT.md` |
| **Temporary Cloudflare** | A real Worker + D1 named `canteenhub-validation`, since deleted. Proved deployment, migrations and a **Time Travel restore** | `CLOUDFLARE-VALIDATION.md` |
| **Production Cloudflare** | **This document.** The real `canteenhub-prod` Worker and database, still running | here |

## Resources

| | |
|---|---|
| Account | `eb0f072a834aaac5311c5d885830903c` |
| Worker | `canteenhub-prod` |
| Version | `150a3523-9500-46b6-995a-1acc71e782c6` |
| Deployed | 2026-09-13T08:42:26Z (9 s; 6 assets; 14 ms startup) |
| URL | `https://canteenhub-prod.tamer-haj.workers.dev` |
| D1 | `canteenhub-prod`, `9c8f5ee4-2620-4822-b5df-5521c130df52`, region ENAM |
| Bindings | `DB` (D1) and `ASSETS` only |
| Cron | `17 3 * * *`, registered 2026-09-13T08:42:26Z |

Migrations applied `--remote`: `0001_initial_schema.sql`, `0002_holidays.sql`,
`0003_import_foundation.sql` → **16 tables, 31 indexes, 4 triggers**, plus the
seeded 3 roles and 3 settings.

## Smoke tests — all against the live production URL

`/api/health` returned `database: connected`. Root, the built JS bundle and the
favicon all served. **All ten deep links** (`/login`, `/`, `/history`,
`/profile`, `/admin`, `/admin/employees`, `/admin/menu`, `/admin/roster`,
`/admin/reports`, `/admin/settings`) returned `200 text/html`, while
`/api/no-such-route` stayed `404 application/json`.

Authentication: login 200, wrong password 401, `/api/auth/me` 200 with no
password/hash/token field, no cookie 401, logout 200, reused cookie 401.
Cookie on real HTTPS: `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`.
Headers: HSTS, `nosniff`, `SAMEORIGIN`, `no-referrer`.

Authorization: seven admin endpoints returned `admin=200 employee=403
anon=401`; an employee reading another employee got 403. The employee listing
carried zero secret-shaped fields. A malformed JSON body returned
`Internal Server Error` — production error opacity confirmed live. A SQL-shaped
search returned an empty result set.

## Production data

**Employees — imported from the real workbook** through the normal
upload → validate → preview → confirm → commit workflow. 14/14 valid, all
CREATE, committed. Result: 10 regular, 3 shift, 2 amman_hq (including the
bootstrap administrator); 5 departments, 10 sections; **zero** stored values
still carrying the source file's stray whitespace; no password set by the
import; every row defaulted to the employee role.

**Roster — NOT imported, and deliberately so.** The roster sheet references
three AMCO IDs that the employee sheet does not contain, so all three rows were
refused with *"No employee with AMCO ID … exists. Import the employee first; a
roster file never creates one."* Nothing was written (`roster_entries = 0`) and
the batch cannot be committed (409). This is exactly the referential rule
`SOURCE-DATA-FINDINGS.md` predicted, now enforced in production. **The fix is a
complete employee sheet, not a workaround** — inventing those three employees
would have given them no `roster_type`, which is the one field the entire
eligibility calculation depends on.

**Menu — NO data created.** The September lunch menu source remains **PDF
only**. No menu XLSX exists, none was fabricated, and no PDF was reconstructed.
**The real September lunch menu XLSX is UNVALIDATED.**

## Application acceptance

Run against production with five clearly-named `ZZTEST0*` fixtures and one
acceptance menu day on **2027-01-03** — a far-future date, deliberately not
September — then **all removed**. Production now holds 0 menu days, 0
selections, 0 history, 0 roster entries and 0 test employees; `audit_log` and
`import_batches` were kept, because they are the record.

Verified live: `REGULAR_WORKING_DAY` eligible on a Sunday · `SHIFT_DAY` eligible
when rostered · `ROSTER_MISSING` for a shift employee with no entry (never
coerced to Off) · `AMMAN_HQ_NO_MEAL` · `EMPLOYEE_INACTIVE` in the report ·
selection option_1 → option_2 → repeat (`changed: false`, **no** extra history
row) → no_preference giving **exactly 3** history entries · ineligible
employees refused server-side.

Settings read from production: `timezone = "Asia/Amman"`,
`lunch_cutoff_time = "10:00"`, `working_days = [0,1,2,3,4]`. The report echoed
`Asia/Amman`. No fixed UTC+3 offset exists anywhere in the code.

Reporting on the acceptance date: `option_2: 1`, `no_preference: 1`,
`eligible_not_selected: 10`, and a per-reason breakdown covering
`REGULAR_WORKING_DAY`, `SHIFT_DAY`, `ROSTER_MISSING`, `AMMAN_HQ_NO_MEAL` and
`EMPLOYEE_INACTIVE`. A malformed `?date=` was rejected with 400.

## Free tier

`DB` and `ASSETS` only. No R2, KV, Durable Object, Queue, Vectorize,
Hyperdrive, Analytics Engine, Browser or AI binding anywhere in `wrangler.toml`.
After the whole deployment and acceptance run, `d1 info` reported **270 kB**,
1,492 rows read and 493 rows written in 24 h — against free-plan ceilings of
500 MB, 5 M reads/day and 100 k writes/day.

## What is NOT proven

1. **Cron firing.** Registration was read back from Cloudflare; Cloudflare
   offers no supported on-demand trigger for a deployed scheduled Worker, so it
   was not observed running. The handler's behaviour was proven locally.
2. **Time Travel on production.** Availability confirmed read-only (a current
   bookmark was returned). **No restore was performed on production** — that
   would mean deliberately damaging live data. Restore itself was proven end to
   end on the throwaway validation database.
3. **The September lunch menu XLSX.** Still PDF-only. Still UNVALIDATED.
4. **Login rate limiting on a deployed Worker.** The limiter keys on
   `<client IP>:<AMCO ID>` and the test environment rotates egress IPs, so
   attempts never accumulate in one bucket. Covered by seven regression tests.

## Operator actions still required

1. **Rotate the bootstrap administrator password.** `ADMIN001` was created with
   a randomly generated password purely to bootstrap access. Change it at first
   login via the admin UI or `PUT /api/admin/employees/:id/password`.
2. **Supply a complete employee sheet** so the roster import can succeed.
3. **Supply the lunch menu as XLSX**, or enter menus manually — the manual CRUD
   exists precisely for this.
4. **Set employee passwords.** The import never sets them; all 14 imported
   employees currently have none and cannot log in.
5. Review `lunch_cutoff_time`, `timezone`, `working_days` and enter holidays.
