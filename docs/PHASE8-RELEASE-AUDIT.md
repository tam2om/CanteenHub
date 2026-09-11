# Phase 8 — Final Acceptance / Release Audit

Audited `main` at `b4d9f15`. Every claim here was measured against a running
Worker, a real D1 and a real browser, or read out of the code. Where something
could not be run, it says so and says why.

---

## 1. Headline

The code is ready. Production is not yet accepted — **no Cloudflare account has
ever been reachable from this repository's build environment**, so a real
deployment and a D1 Time Travel restore remain untested, as they have since
Phase 6.

What changed in this audit:

- **The real employee/roster workbook was finally available and has now been run
  through both importers end to end.** Phase 7 could not do this. Real-source
  validation for employees and roster is now **PASS**, not partial.
- **One security control had no test at all** — login rate limiting. It works;
  nothing guarded it. Seven tests added.
- **One unused runtime dependency removed** (`jose`, a JWT library, zero
  imports — this system uses opaque session cookies).
- **Two documentation claims were materially wrong** and are corrected.

No production-code defect was found. No migration was needed.

---

## 2. Automated quality

| Gate | Before | After |
|---|---|---|
| `npm test` | 941 passed, 30 files | **948 passed, 30 files** |
| `npm run typecheck` | clean | clean |
| `npm run lint` | clean (`--max-warnings 0`) | clean |
| `npm run build` | clean | clean |

903 `it()` blocks across 30 files. No test was weakened, deleted, or changed to
make it pass.

**Coverage gap found and closed.** Every eligibility reason, the cutoff, the
next-eligible-date search, logout, session revocation and the R2 archive are all
exercised by name. **Login rate limiting was not** — the only reference to
`login_attempts` anywhere under `tests/` was the maintenance cron purging it.
That is a security control on the only authentication endpoint, and it was
guarded by nothing. Seven tests now cover: five failures allowed and the sixth
locked; the *correct* password refused while the lock holds; the wait message
leaking nothing; the lock scoped to one IP so nobody can lock out a colleague;
scoped to one account so one victim does not lock out the office; an unknown
AMCO ID costing exactly what a real one costs; and successful logins never
locking anyone out.

---

## 3. Real source data — employees and roster now validated

The workbook named in `SOURCE-DATA-FINDINGS.md` was present in this session and
was uploaded through the live API against a throwaway D1. **It is not committed
and never will be — it contains real employee names and identifiers.**

Structure confirmed byte-for-byte against the document: two sheets,
`Shifts roster` (`A1:AH4`, 3 data rows) and `All Employees` (`A1:E15`, 14 data
rows); headers `AMCO ID#|Name|Department|Section|Roster` and
`code|month|year|1…31`.

**Employees — 14/14 valid, all CREATE, committed.**

| Check | Result |
|---|---|
| Roster values mapped | `Regular`→regular 9, `Shift`→shift 3, `Amman HQ`→amman_hq 2 |
| Departments / sections | 5 / 10 |
| Stored values still carrying stray whitespace | **0** — the real file's `"Maintenance  "` and `" Fleet &Transportation  "` were trimmed |
| AMCO IDs matching the documented `AMCO###` shape | 14/14 |
| Passwords set by the import | **0** — an employee import never touches credentials |
| Roles / active flags | all defaulted correctly; none overridden |

**Roster — the documented referential finding reproduced exactly.** On the first
attempt all three rows were **refused**: the roster sheet names employees the
(partial) employee sheet does not contain, and the importer never auto-creates
an employee — because an auto-created employee has no `roster_type`, and
`roster_type` is what the whole eligibility calculation depends on. This is the
behaviour `SOURCE-DATA-FINDINGS.md` §2 predicted, now demonstrated rather than
reasoned about.

With those employee codes seeded, the real roster parsed cleanly: **90 entries =
3 employees × 30 September days**, dates exactly `2026-09-01 … 2026-09-30`, the
day-31 column correctly ignored for a 30-day month, values `day` 38 / `night` 6
/ `off` 46, every row `source = import`.

**Idempotency.** Re-importing the identical workbook: employees classified
**14/14 UNCHANGED**, roster **"0 new, 0 changed, 90 already correct"**, and the
whole database unmoved — employees 18, roster 90, selections 1, history 3, menu
days/options/components unchanged, passwords 3, admins 1, menu still
`published`. Only `audit_log` grew, which is correct: the import itself is the
event.

**The menu is still PDF-only.** A filesystem-wide search finds exactly one
`.xlsx` — the employee/roster workbook — and the September lunch and dinner
menus as PDFs. **No menu `.xlsx` exists.** The menu importer therefore remains
contract-validated, not real-source validated, and no PDF extractor was built
(`SOURCE-DATA-FINDINGS.md` §3.1 explains why one would be worse than useless).

---

## 4. Security

No BLOCKER. No HIGH.

**Verified against the running Worker**

| Control | Evidence |
|---|---|
| Authorization | employee → 403 on all seven `/api/admin/*` endpoints, on another employee's selections and history, on the admin override, and on setting anyone's password; anonymous → 401 |
| Employee isolation | `/api/me/*` derives identity from the session only; the legacy `/api/employees/:id` refuses every id but the caller's own (403 × 5 probed) |
| Password secrecy | no response carries `password_hash`, a hash, or a token; the admin listing returns 10 fields, none sensitive |
| Session security | setting a password revokes existing sessions — the old cookie went 401 immediately, the old password 401 |
| Rate limiting | 5 failures → 401, 6th → 429, correct password → 429 while locked; key is `<IP>:<AMCO ID>` |
| SQL injection | the three SQL interpolations are built **only** from hardcoded literals (`'b.import_type = ?'`, `'roster_type = ?'`, `'?'` placeholders); every user value is bound. A SQL-shaped search returns an empty set; a SQL-shaped login 401 |
| XSS | zero `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in the entire codebase |
| CSRF | `SameSite=Strict` on the session cookie; the SPA is served same-origin so no cross-site request carries it |
| CORS | a hostile `Origin` receives the configured origin, not its own — the browser blocks the response |
| Headers | HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer` |
| Upload security | 12 MB upload → **413**; a text file named `.xlsx` → **400**; an upload named `../../../../etc/passwd.xlsx` stored at the server-derived `imports/menu/<id>/source.xlsx` — the filename never reaches the key |
| Error opacity | production masks every error to `Internal Server Error`; detail goes to `wrangler tail` |
| Logging | no password, hash, token or cookie value is ever logged — the only "hash" strings in log calls are format descriptions |
| Frontend bundle | zero occurrences of `pbkdf2`, `password_hash`, `CLOUDFLARE`, `api_key` or `database_id` |
| Secrets in source | none; `wrangler.toml` carries `REPLACE_WITH_…` placeholders only |

**Findings**

| Severity | Finding | Action |
|---|---|---|
| MEDIUM | Login rate limiting had **no test**. The control works, but nothing guarded it against a refactor — the same class of gap that hid three Phase 7 defects. | **Fixed** — 7 regression tests |
| LOW | `readEntry` in `lib/xlsx.ts` buffers a ZIP entry fully before checking its inflated size, so a crafted workbook declaring a small `uncompressedSize` but inflating past the 64 MB cap can exhaust Worker memory. Requires an **authenticated admin**, and costs that admin their own request; the batch is left in `validating` with the documented §4.1 recovery. | Recorded, not fixed — a streaming size-capped reader is a real change to the XLSX reader for an authenticated-admin self-DoS |
| LOW | Malformed JSON body returns **500** where 400 is correct. Production masks the message, so nothing leaks; only the status class is wrong. Carried from Phase 7. | Recorded — fixing it properly means changing how every route parses its body |
| LOW | An unused runtime dependency (`jose`, a JWT library) sat in `dependencies` with zero imports. | **Fixed** — removed |
| INFORMATIONAL | No Content-Security-Policy header. There are no XSS sinks and no inline handlers, so this is defence in depth rather than a gap. | Not changed |
| INFORMATIONAL | `routes/employee.ts` is leftover Phase 1 surface — the SPA never calls it and it is correctly authorized. | Not removed; removing a mounted router is a behaviour change for no release benefit |
| INFORMATIONAL | `.gitignore` is wrapped in literal markdown fences. Verified harmless: every rule resolves, and the fence lines only match a file named ``` ``` ```. | Not changed (cosmetic) |

---

## 5. Business rules

**Exactly one authoritative eligibility implementation.** `domain/eligibility.ts`
is the only module implementing the rules, and it is pure — zero references to
`D1Database`, `c.env` or `await`. Both callers import it:
`services/eligibility.service.ts` and `services/reports.service.ts`. The reason
strings in the report service are display labels keyed off the domain's reason
codes, not a second rule set. Both the read path (`/api/me/today`) and the write
path (`POST /api/selections/me`) go through `getEligibilityWithNextDate`.

Verified live on real imported data: `SHIFT_DAY` eligible, `SHIFT_OFF` refused,
`ROSTER_MISSING` never coerced to Off, `AMMAN_HQ_NO_MEAL` with
`nextEligibleDate: null`, `REGULAR_NON_WORKING_DAY`, `HOLIDAY`,
`EMPLOYEE_INACTIVE`, and the cutoff refusing a write after it had genuinely
passed in Amman.

**No hard-coded horizon.** `findNextEligibleMealDate` searches the set of
published menu dates, not a calendar window — "not 365 days, not 90, not any
number". An eligible date two years out is found if its menu is published;
otherwise the answer is `null` rather than an invented date.

---

## 6. Timezone

| Search | Result |
|---|---|
| Fixed `+03` / `03:00` offsets | **none** — the only match is a comment in `datetime.ts` explaining why not to |
| `Asia/Amman` outside the helper | only `DEFAULT_TIMEZONE`, comments, and the seeded `settings` row — it is configurable |
| Hard-coded `10:00` cutoff | only the seeded migration default; the code reads the setting |
| `getUTC*` | confined to `datetime.ts` (calendar arithmetic on UTC-anchored dates, the standard safe technique) and `imports/menu.ts` (Excel serial dates, inherently UTC-anchored) |
| `toISOString()` | **stored timestamps only** — audit, selection history, rate-limit windows, session expiry, health. Permitted and correct |
| Browser date computation | **none.** The frontend contains no `new Date()`, `toLocaleDateString`, `getFullYear`, `getMonth` or `getDate`. Every date comes from the server |

Business dates go through `getBusinessDate()`, which formats via
`Intl.DateTimeFormat('en-CA', { timeZone })` and falls back to the default on an
invalid IANA name rather than crashing the request.

---

## 7. Data integrity

Full lifecycle exercised on the real imported data: employee → roster →
eligibility → menu → selection → change → no-op → history → report, and
import → R2 archive → validate → preview → commit → audit.

- Selection changed twice and repeated once: history holds **exactly 3 rows**
  for 3 real changes; the no-op added nothing and returned `changed: false`
- Report matched reality: 1 eligible, 1 selection, correct reason breakdown
- Re-import destroyed nothing (§3)
- **23 consistency checks, all zero**: orphaned roster entries, menu options,
  menu components, selections (by employee and by menu day), selection history,
  import rows, import batches and audit rows; duplicate employees, roster days,
  menu days, menu options and selections; published menu days with other than
  two options; selections without history; committed batches with no rows;
  batches with no R2 key; invalid shift values; roster rows with a source
  outside `import`/`manual`; employees with no role or an out-of-enum roster
  type; soft-deleted roster rows still counted

---

## 8. Operational limits, as built

| Limit | Value | Assessment |
|---|---|---|
| Upload size | 10 MB, enforced (413) | Acceptable |
| XLSX inflated size | 64 MB, checked before and after inflation | Acceptable (see the LOW finding in §4) |
| Import staging chunk | 20 rows × 5 params = 100, D1's exact ceiling | Acceptable — derived from the constants, not a literal |
| Preview rows returned | 100 | Acceptable |
| Employee listing page | ≤ 100, default 20 | Acceptable |
| Import history page | clamped | Acceptable |
| Selection history page | clamped | Acceptable |
| Upcoming menus | ≤ 30 | Acceptable |
| Login lockout | 5 attempts / 15 min, keyed `<IP>:<AMCO ID>` | Acceptable; release procedure now in `RECOVERY.md` §4.3 |
| Session and login-attempt cleanup | nightly cron `17 3 * * *` | Acceptable |
| Audit / history retention | **none, by design** | Acceptable for initial deployment; needs a stated policy eventually |
| `GET /api/roster/admin/day` | **unpaginated by design** — 68 KB at 313 employees, ~220 KB at 1,000 | Acceptable initially; **requires mitigation** if the workforce grows severalfold |
| Real Worker CPU time | **unmeasured** | Requires measurement on a real deployment; the 3,600-entry roster commit (184 ms wall, local) is the one to watch against the 10 ms CPU limit |

None of these is a release blocker.

---

## 9. Browser and accessibility

Re-verified on this commit, Chromium at 390×844 and 1440×900 — **87 assertions,
0 failures**. All ten routes on direct navigation and reload; a logged-in
session survives direct navigation, hard reload and browser Back; logout returns
to login and a protected route then bounces; `ConfirmDialog` opens as
`role="alertdialog"` with `aria-modal="true"` and focus on **Cancel**, Escape
cancels, focus returns to a real control in the same row; no horizontal page
scroll on any admin route at either width; wide tables inside `overflow-x`
containers; admin nav (9 links) does not overflow; every visible control ≥ 32px
tall on mobile; no uncaught JavaScript anywhere.

No browser framework was added. The driver script is not committed —
`E2E-STATUS.md` records this honestly.

---

## 10. Cloudflare acceptance status

```
$ env | grep -icE '^(CLOUDFLARE|CF_API|WRANGLER)'   -> 0
$ ls /root/.config/.wrangler/config                  -> No such file or directory
$ npx wrangler whoami                                -> You are not authenticated.
```

| Item | Status |
|---|---|
| A. Real Cloudflare deployment | **UNVALIDATED** |
| B. Live smoke tests | **UNVALIDATED** |
| C. D1 Time Travel restore | **UNVALIDATED** |
| D. Real production cron | **UNVALIDATED** (registered in config; fires locally via `--test-scheduled`) |
| E. Real D1/R2 production bindings | **UNVALIDATED** (a `--dry-run` resolves all five bindings) |
| F. Real DNS/TLS | **UNVALIDATED** |

This is an environment limitation, not a code defect. It is also the reason this
audit separates **code ready** from **production accepted**.

---

## 11. Requirements traceability

**AUTHENTICATION** — employee login IMPLEMENTED · admin login IMPLEMENTED ·
password hashing IMPLEMENTED (PBKDF2-SHA-256, 100k, platform ceiling) · direct
admin password setting IMPLEMENTED · session management IMPLEMENTED (opaque
token, SHA-256 at rest) · logout IMPLEMENTED · session revocation IMPLEMENTED ·
rate limiting IMPLEMENTED

**EMPLOYEE** — today's lunch, Option 1, Option 2, No Preference, cutoff,
eligibility, history, profile, ineligible handling — all IMPLEMENTED

**ELIGIBILITY** — Regular Sun–Thu · Regular Fri–Sat · Shift Day · Shift Night ·
Shift Off · missing roster · Amman HQ · inactive · holidays · authoritative
server-side calculation · next eligible date — all IMPLEMENTED

**MENU** — monthly menu, exactly two selectable options, components, draft,
publish, archive, employee visibility, menu editing, menu import — all
IMPLEMENTED. Menu import is **UNVALIDATED against real source** (PDF-only).
Deleting a single option or component is **NOT IMPLEMENTED**

**ROSTER** — Excel import IMPLEMENTED *and real-source validated* · manual
management IMPLEMENTED · Day/Night/Off IMPLEMENTED · missing roster IMPLEMENTED
· roster history/audit IMPLEMENTED

**EMPLOYEES** — Excel import IMPLEMENTED *and real-source validated* · manual
management · activation/deactivation · department/section · roster type ·
password preservation · role preservation — all IMPLEMENTED

**IMPORTS** — Upload · Validate · Preview · Confirm · Commit · validation
failure · commit failure · idempotency · R2 archive · import history · audit —
all IMPLEMENTED

**REPORTING** — Option 1 · Option 2 · No Preference · eligible but not selected
· not eligible · reason breakdown · published-menu behaviour — all IMPLEMENTED

**ADMIN** — employee management · menu management · roster management · reports
· settings · holidays · imports — all IMPLEMENTED

**SECURITY** — authorization · employee isolation · password secrecy · session
security · CORS · SQL injection protection · upload security · error opacity ·
sensitive logging — all IMPLEMENTED

**INFRASTRUCTURE** — Workers · D1 · R2 · static assets · SPA fallback · cron ·
deployment configuration · recovery documentation — all IMPLEMENTED, all
**UNVALIDATED on real Cloudflare**

**DEFERRED, by decision:** PDF menu extraction · browser test framework ·
audit/history retention policy · CI pipeline · bundle splitting · Argon2id
(needs the paid plan)

---

## 12. Release matrix

| Area | Status | Evidence |
|---|---|---|
| Automated tests | **PASS** | 948 passed, 30 files, 903 `it()` blocks |
| Typecheck / lint / build | **PASS** | all clean on this commit |
| Security | **PASS** | no BLOCKER, no HIGH; §4 |
| Business rules | **PASS** | one authoritative pure engine; §5 |
| Data integrity | **PASS** | 23/23 consistency checks; full lifecycle; §7 |
| Imports | **PASS** | real workbook, idempotent, R2-archived; §3 |
| Menu | **PASS (code)** | manual CRUD, draft/publish/archive verified live |
| Roster | **PASS** | real roster parsed, 90/90 correct; §3 |
| Reporting | **PASS** | counts matched reality; §7 |
| Employee portal | **PASS** | full journey, both widths; §9 |
| Admin portal | **PASS** | full journey, both widths; §9 |
| Browser / accessibility | **PASS** | 87/87 assertions; §9 |
| Deployment config | **PASS (config)** | `--dry-run` resolves all five bindings |
| Cloudflare live validation | **UNVALIDATED** | no credentials; §10 |
| Time Travel | **UNVALIDATED** | needs a real account; §10 |
| Real source data | **PASS (employees, roster)** / **PARTIAL (menu)** | §3 |
| Recovery | **PARTIAL** | export→restore and both stuck-batch procedures rehearsed; Time Travel never |
| Documentation | **PASS** | two wrong claims corrected this phase; §13 |

---

## 13. Documentation corrected in this phase

- `ARCHITECTURE.md` §15.2 claimed account lockout was "recorded on the employee
  row and audited". **Neither is true** — the `employees` table has no lockout
  column and a lockout writes no `audit_log` entry. The state is in
  `login_attempts`, keyed `<IP>:<AMCO ID>`. Corrected, with the reason the
  composite key is the right design.
- `RECOVERY.md` gains **§4.3, releasing a login lockout**. There was no
  documented procedure, and the obvious command (`WHERE identifier = 'AMCO123'`)
  silently deletes nothing because the key is composite — which this audit hit
  in practice.
- `SOURCE-DATA-FINDINGS.md` and `PHASE7-ACCEPTANCE.md` now record that the real
  workbook *was* run through the importers, and that the menu remains PDF-only.

---

## 14. Known limitations

1. **Cloudflare deployment and D1 Time Travel have never been tested.** Nothing
   may be called production-ready until both are done on a real account.
2. **The menu importer is not real-source validated** — no menu `.xlsx` exists.
3. **Real Worker CPU time is unmeasured**; the 10 ms limit is CPU, and every
   figure in this repository is wall-clock from a local runtime.
4. Malformed JSON returns 500 instead of 400 (masked in production).
5. A crafted workbook can exhaust Worker memory during inflation
   (authenticated-admin only).
6. No endpoint deletes a single menu option or component.
7. `GET /api/roster/admin/day` is unpaginated by design and grows linearly.
8. No audit/history retention policy.
9. No browser test framework is committed.
10. No CI pipeline — deployment is manual by the documented sequence.

---

## 15. Verdict

# READY FOR RELEASE — DEPLOYMENT VALIDATION PENDING

There are **no unresolved code or release blockers**. Every BLOCKER and HIGH
class is clear, the business rules have one authoritative implementation, the
data lifecycle is intact under real data, and the importers now hold against the
real workbook rather than a fixture.

What is outstanding is **external validation, not code**: a real Cloudflare
deployment with the live smoke tests, and a rehearsed D1 Time Travel restore.
Until an operator completes `RELEASE-CHECKLIST.md` against a deployed URL, this
project is **code release ready** and **production acceptance pending** — and
those are not the same thing.
