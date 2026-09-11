# Phase 7 — Real-World Validation & Acceptance

Run against `origin/main` at `77a4667`. Everything below was measured, not
reasoned about. Where something could not be run, it says so and says why.

---

## 1. Was anything deployed to Cloudflare? No.

```
$ env | grep -icE '^(CLOUDFLARE|CF_API|WRANGLER)'   -> 0
$ ls /root/.config/.wrangler/config                  -> No such file or directory
$ npx wrangler whoami                                -> You are not authenticated.
```

The **Cloudflare Developer Platform** connector is installed on the account but
reports `installState: needs_reconnect`, `connected: false`,
`enabledInChat: false`. `api.cloudflare.com` is reachable (HTTP 400 to an
unauthenticated token-verify — the network path is fine); only the credential is
missing. No credential was requested, stored or committed.

**Therefore still UNVALIDATED, exactly as after Phase 6:**

- real Cloudflare deployment and live smoke testing;
- D1 **Time Travel** restore rehearsal.

Nothing in this document should be read as evidence for either.

## 2. What was run instead

A real Worker under `wrangler dev` — `workerd`, real D1 through wrangler's own
migration machinery, real R2 blobs on disk — plus a real Chromium driven against
it over HTTPS (`--local-protocol https`, so the `Secure` cookie behaves as it
will in production). This is genuine runtime validation. It is **not** a
substitute for Cloudflare's edge: it does not exercise the real asset router,
real DNS/TLS, real cron scheduling, D1 replication, or the 10 ms Worker CPU
limit.

---

## 3. Defects found

Three, all production-blocking, all invisible to a green 931-test suite.

### 3.1 Every page reload logged the user out

`app.use('/api/*', sessionMiddleware)` was registered **after**
`app.route('/api/auth', authRoutes)`. Hono matches in registration order, so the
middleware never ran for that router and `c.get('employee')` was permanently
undefined inside it.

- `GET /api/auth/me` → **401 with a valid session cookie.** The SPA restores its
  session from this endpoint on every page load, so a reload, a bookmark or a
  typed URL returned the user to the login screen.
- `PUT /api/auth/change-password` → **401 always.** Self-service password change
  was unreachable in its entirety.

Found by driving a browser; confirmed with `curl` carrying a valid cookie, where
`/api/me/today` returned 200 and `/api/auth/me` returned 401 on the same
request. Fixed by registering the middleware before any router. It only
populates context and never rejects, so login and logout are unaffected.

### 3.2 No workbook of real size could be imported

`saveValidationResults` chunked staged rows at **50 rows** per multi-row INSERT,
sized against D1's 50-queries-per-batch limit. Each row binds five parameters,
and D1 also caps a statement at **100 bound parameters**, so validation failed
with `too many SQL variables` and left the batch stuck in `validating`.

Measured threshold: **20 rows pass, 21 rows fail.** A 30-day menu, any real
employee list and any real roster were all impossible. The chunk size is now
derived from the two constants rather than written as a literal.

### 3.3 Menu management scrolled sideways on every desktop width

`.button` sets `width: 100%` for the stacked mobile layout. At ≥40rem the action
groups switched to `flex: 0 0 auto`, which resolves flex-basis from that width
*and* forbids shrinking, so each button claimed a full row. A menu-day card has
three (Edit / Archive / Publish).

Measured in Chromium with a committed 30-day menu: document width 2931px at
1440px, 2723px at 1024px, 2115px at 768px; 390px was unaffected, because the
base `flex: 1` still shrinks there. Fixed with `width: auto` in the same rule.

---

## 4. Acceptance areas

| Area | Status | Evidence |
|---|---|---|
| Real Cloudflare deployment | **BLOCKED** | No credentials; see §1 |
| Live smoke test on Cloudflare | **BLOCKED** | Depends on the above |
| D1 Time Travel rehearsal | **BLOCKED** | Needs a real account; `RECOVERY.md` still marks it unverified |
| Local deployment & runtime validation | **PASS** | `wrangler deploy --env production --dry-run` clean; migrations applied; all routes served |
| Real source-file validation | **PARTIAL** | No workbook was available in this environment; see §5 |
| Import data integrity | **PASS** | Every documented classification and error case, §6 |
| End-to-end business scenarios | **PASS** | 14/14, §7 |
| Data consistency | **PASS** | 21 checks, all zero, §8 |
| Security acceptance | **PASS** | §9 |
| Performance | **PASS (with a recorded limit)** | §10 |
| Frontend / browser | **PASS** | 87 browser assertions at two widths, §11 |
| Documentation accuracy | **PASS** | Corrections in this commit |
| Automated gates | **PASS** | 941 tests, typecheck, lint, build |

---

## 5. Real source files — PARTIAL, and why

No workbook of any kind exists in this environment: `find` over the repository
and home directory returns no `.xlsx`, `.xls` or `.pdf`. The employee and roster
workbooks were examined in Phase 0 (see `SOURCE-DATA-FINDINGS.md`, verified
2026-09-09) and correctly never committed, because they contain real employee
names and IDs. They were therefore **not re-run through the importers here.**

What was validated instead: workbooks built to the **documented contract** from
`SOURCE-DATA-FINDINGS.md`, with synthetic names — including the real file's
quirks (`AMCO ID#` vs `code` headers, Title Case `Regular`/`Shift`/`Amman HQ`,
the stray whitespace in `"Maintenance  "` and `" Fleet &Transportation  "`, 31
day columns in a 30-day month, and `Option Meal 1/2` as accompaniments rather
than choices). That proves the importers honour the contract. It does **not**
prove the real files conform to it.

**The real September lunch menu is still not available as XLSX.** It was
supplied as a PDF print export (`SOURCE-DATA-FINDINGS.md` §3.1), and that
remains true. No PDF extractor was built. **The menu importer is not
real-source validated.**

---

## 6. Import data integrity

All against a throwaway local D1, through the real HTTP API.

**Employees** — UNCHANGED (byte-identical, and whitespace-only difference),
UPDATE (department/section/roster, and name-only), CREATE, and every error:
duplicate AMCO ID (both rows refused), missing AMCO ID, missing name,
unsupported roster value, missing roster. A workbook with any invalid row is
refused whole (`validation_failed`) and cannot be committed.

Preserved across a re-import, verified before and after: **password hashes**,
**role_id** (an admin stayed an admin), **is_active** (a deactivated employee
was not revived), lunch selections, selection history, and all 109 roster
entries. Login with the pre-import password still worked afterwards.

**Roster** — 109 day-entries from 4 rows, blanks left absent rather than coerced
to `Off`, lower-case and padded values (` day `, `NIGHT`, `off`) accepted. Every
error case: unknown AMCO ID (never auto-created), a populated day-31 cell in a
30-day month, duplicate employee/date, unsupported shift value, month `13`.

**Menu** — 30 days, exactly 2 options each, 134 components, all `draft`; dates
mapped `01-Sep-26` → `2026-09-01`; blank component cells omitted rather than
stored empty. Errors: one option only, identical options, duplicate date,
unparseable date, no options at all.

A two-sheet workbook (the real employee/roster file's shape) routed to the
correct sheet by import type.

---

## 7. End-to-end business scenarios

Today in the business timezone was 2026-09-11, a Friday, with working days
`[0,1,2,3,4]`.

| # | Scenario | Result |
|---|---|---|
| 1 | Eligible employee selects; report and history reflect it | PASS |
| 2 | Regular employee, non-working day | `REGULAR_NON_WORKING_DAY` |
| 3 | Shift Day | eligible, `SHIFT_DAY` |
| 4 | Shift Night | eligible, `SHIFT_NIGHT` |
| 5 | Shift Off | `SHIFT_OFF` |
| 6 | Missing roster | `ROSTER_MISSING` — never `Off` |
| 7 | Amman HQ | `AMMAN_HQ_NO_MEAL` |
| 8 | Holiday | `HOLIDAY` |
| 9 | Draft menu | invisible to employees (404), visible to admin |
| 10 | Archived menu | invisible; eligibility itself unchanged |
| 11 | Cutoff | read from the setting, evaluated in `Asia/Amman`; writes refused after it |
| 12 | Roster correction Day → Off | eligibility flips; selection and history intact; report shows `ineligible_with_selection: 1` rather than deleting anything |
| 13 | Published menu corrected | option updated in place, selection preserved, employee sees the current menu, status stays `published` |
| 14 | Import upload → validate → preview → commit | PASS, §6 |

Eligibility is enforced on the write path too: selections by ineligible
employees were refused with the matching reason.

---

## 8. Data consistency

21 checks after all of the above, every one zero: orphaned roster entries, menu
options, menu components, selections, selection history, import rows, import
batches and audit rows; duplicate employees, roster days, menu days, menu
options and selections; menu days with other than two options; selections
without history; committed batches with no rows; batches with no R2 key; invalid
shift values; roster rows with a source outside `import`/`manual`; employees with
no role.

Audit coverage matched the actions performed exactly — 13 uploads, 10
validations, 4 commits, and one entry each for the password set, holiday
create/delete, menu publish/archive, option update, component create, roster
delete and three roster updates. No unexpected deletes, no missing entries.

---

## 9. Security acceptance

Verified against the running Worker: an employee is refused (403) on all seven
admin endpoints, on another employee's selections and history, on the admin
override, and on setting anyone's password; unauthenticated requests are 401;
the employee listing returns no password, hash, token or session field;
`PUT .../password` returns only `{password_set: true, sessionsRevoked: n}` and
the old password and old session both stop working immediately.

An upload named `../../../../etc/passwd.xlsx` was stored under the
server-derived key `imports/menu/13/source.xlsx` — the filename never reaches
the key, and `r2_object_key` is not returned by the API at all.

Malformed and SQL-shaped input: malformed dates 400, malformed ids 400, a
SQL-shaped employee search returns an empty result set (parameterised, not
interpolated), a SQL-shaped login 401.

**Known, not fixed:** a malformed JSON body produces **500** where 400 would be
correct. In production the message is masked to `Internal Server Error`, so
nothing internal leaks and the security requirement holds; the status is simply
the wrong class. Fixing it properly means changing how every route parses its
body, which is beyond a validation pass — recorded rather than done.

---

## 10. Performance

Measured at **313 employees and 3,709 roster entries**, wall-clock against local
`workerd`:

| Operation | Time |
|---|---|
| Employee listing (page of 50) | 9–16 ms |
| Employee listing with search | 9–10 ms |
| Roster day listing (all 313) | 10–18 ms |
| Report, one day | 18–22 ms |
| Report, 30-day range | 18–25 ms |
| Menu month view (30 days, 60 options, 134 components) | 12–14 ms |
| Import validation, 300 employees | 41 ms |
| Import commit, 300 employees | 37 ms |
| Import commit, 3,600 roster entries | 184 ms |

No N+1: there is no awaited database call inside a loop anywhere in the services
or repositories, and the roster day view over 313 employees is a single join.
The employee listing bounds its page size — `limit=100000` returns 20.

**Recorded limitation.** `GET /api/roster/admin/day` is not paginated by design
— the whole point of the view is every employee on one date — and returned
**68 KB for 313 employees**. That grows linearly: roughly 220 KB at 1,000.
Acceptable now; the first thing to revisit if the workforce grows severalfold.

**Not measured, and not measurable here: real Worker CPU time.** The 10 ms limit
applies to CPU, and these are wall-clock figures from a local runtime. The
3,600-entry roster commit is the operation to watch on a real deployment.

---

## 11. Frontend / browser

Chromium, at 390×844 and 1440×900, against the real Worker over HTTPS. 87
assertions, all passing after the fixes in §3:

- All ten routes serve the SPA shell on direct navigation and on reload.
- A logged-in session survives direct navigation to every route, a hard reload,
  and browser Back. (This is §3.1's regression.)
- Invalid credentials show `Invalid AMCO ID or password.` — no hash, SQL or
  stack text.
- Logout returns to login, and a protected route then bounces to login.
- `ConfirmDialog`: opens as `role="alertdialog"` with `aria-modal="true"`, puts
  focus on **Cancel** (the safe option), Escape cancels, and focus returns to a
  real control in the same row rather than to a detached node.
- No horizontal page scroll on any admin route at either width; wide tables sit
  inside `overflow-x` containers; the admin nav (9 links) does not overflow.
- Every visible control is at least 32px tall at mobile width.
- No uncaught JavaScript anywhere in the journey.

`/admin/imports` has no route of its own — only `/admin/imports/employees`,
`/roster` and `/menu` — so it serves the shell and the client router redirects
to `/`. Intentional; noted because the acceptance list names that path.

---

## 12. Known remaining gaps

1. **Cloudflare deployment and Time Travel remain unvalidated.** The system must
   not be called production-ready until both are done on a real account.
2. **The menu importer is not real-source validated** — the real September menu
   is still PDF-only.
3. **The employee and roster importers are contract-validated, not
   real-file validated** in this environment.
4. **Malformed JSON returns 500 instead of 400** (§9).
5. **No endpoint deletes a single menu option or component.** A component added
   by mistake can only be removed by deleting the whole menu day. Not blocking;
   worth a slice.
6. **No browser test framework is committed.** Phase 7's browser validation was
   performed with an uncommitted driver script. See `E2E-STATUS.md`.
7. **Real Worker CPU time is unmeasured** (§10).
