# CanteenHub — Production Smoke Tests

Run after every production deployment. Roughly 15 minutes.

**Use synthetic accounts and dates.** Nothing here needs real employee data. A
`TEST…` employee and a menu a fortnight out exercise every path without
disturbing a live service.

Legend: ✅ expected · ❌ must NOT happen

---

## 0. Reachability

| # | Step | Expected |
|---|---|---|
| 0.1 | `curl -s https://<host>/api/health` | ✅ success payload |
| 0.2 | Open `https://<host>/` | ✅ the app loads, not JSON |
| 0.3 | Open `https://<host>/admin/menu` **directly** | ✅ the app loads — ❌ a JSON 404 means `[assets]` is misconfigured |
| 0.4 | Reload on that deep link | ✅ still loads |

---

## 1. Authentication

| # | Step | Expected |
|---|---|---|
| 1.1 | Sign in as an employee | ✅ portal |
| 1.2 | Sign in as an admin | ✅ admin area |
| 1.3 | Wrong password | ✅ refused; ❌ never reveals whether the AMCO ID exists |
| 1.4 | Repeat 1.3 several times | ✅ rate-limited/locked out |
| 1.5 | Inspect the session cookie in devtools | ✅ `HttpOnly`, `Secure`, `SameSite=Strict`; ❌ not readable from `document.cookie` |
| 1.6 | Check `localStorage` and `sessionStorage` | ❌ no token, no password |
| 1.7 | Sign out, press Back | ✅ not signed in |
| 1.8 | Visit `/admin/employees` while signed out | ✅ refused |
| 1.9 | Visit `/admin/employees` as an **employee** | ✅ refused |
| 1.10 | Admin sets an employee's password | ✅ that employee's existing sessions are revoked |

---

## 2. Employee portal

Precondition: a **published** menu for today and an eligible employee.

| # | Step | Expected |
|---|---|---|
| 2.1 | Open the portal | ✅ today's menu, both options, components |
| 2.2 | Choose Option 1 | ✅ saved and reflected |
| 2.3 | Choose Option 2 | ✅ changed |
| 2.4 | Choose No Preference | ✅ saved — ❌ never shown as a third menu option |
| 2.5 | Re-tap the option already chosen | ✅ accepted, no error |
| 2.6 | After the cutoff | ✅ selection refused with a clear reason |
| 2.7 | As an Amman HQ employee | ✅ ineligible, reason shown |
| 2.8 | As a shift employee rostered **off** | ✅ ineligible |
| 2.9 | As a shift employee with **no roster** | ✅ "roster not published" — ❌ never shown as "off" |
| 2.10 | On a company holiday | ✅ ineligible, holiday reason |
| 2.11 | History page | ✅ past selections; ❌ nobody else's |
| 2.12 | Profile page | ✅ own details; ❌ no password hash |

---

## 3. Admin — employees, settings, holidays

| # | Step | Expected |
|---|---|---|
| 3.1 | Employees list, search, filter, paginate | ✅ works server-side |
| 3.2 | Create an employee | ✅ created, cannot sign in until a password is set |
| 3.3 | Set a password | ✅ succeeds; ❌ the password is never displayed or echoed |
| 3.4 | Deactivate, then reactivate | ✅ confirmation required for the destructive step |
| 3.5 | Change the lunch cutoff | ✅ saved and honoured by the portal |
| 3.6 | Confirm the timezone setting | ✅ an IANA name (`Asia/Amman`) — ❌ never a numeric offset |
| 3.7 | Add a holiday, then remove it | ✅ eligibility changes accordingly |

---

## 4. Admin — menu and publishing

| # | Step | Expected |
|---|---|---|
| 4.1 | Open Menus, navigate months | ✅ server-driven; drafts visible |
| 4.2 | Add a menu day | ✅ created as **draft** |
| 4.3 | Try to publish with one option | ✅ refused, reason given |
| 4.4 | Fill both options, save | ✅ still a draft — ❌ saving must never publish |
| 4.5 | As an employee, look for that date | ✅ not visible; selection refused |
| 4.6 | Publish it (confirmation required) | ✅ published |
| 4.7 | As an employee | ✅ now visible and selectable |
| 4.8 | Edit an option on the **published** day | ✅ stays published — ❌ must not silently revert to draft |
| 4.9 | Archive it | ✅ no longer offered; existing selections **kept** |

---

## 5. Admin — roster

| # | Step | Expected |
|---|---|---|
| 5.1 | Open Roster for a date | ✅ **every** employee listed, including those with no entry |
| 5.2 | An employee with no entry | ✅ "No roster" — ❌ never "Off" |
| 5.3 | Search by name and by AMCO ID | ✅ server-side |
| 5.4 | Set Day / Night / Off | ✅ saved |
| 5.5 | Re-set the same value | ✅ no-op; ❌ no new audit row |
| 5.6 | Remove an entry (confirmation required) | ✅ becomes "No roster" |
| 5.7 | Check that employee's eligibility | ✅ `ROSTER_MISSING` — ❌ not `SHIFT_OFF` |
| 5.8 | Set Day again | ✅ eligible immediately |

---

## 6. Admin — reports

| # | Step | Expected |
|---|---|---|
| 6.1 | Report for a date with selections | ✅ counts match what was chosen |
| 6.2 | Option 1 / Option 2 / No Preference | ✅ counted separately |
| 6.3 | An eligible employee who did not choose | ✅ "eligible, not selected" |
| 6.4 | An ineligible employee | ✅ **not** counted as "not selected" |
| 6.5 | Reason breakdown | ✅ codes and readable reasons |
| 6.6 | A date with no published menu | ✅ said plainly; counts are zero, not blank |
| 6.7 | A date where nothing happened | ✅ zeros shown as `0` — ❌ not omitted |

---

## 7. Admin — imports

For each of employees, roster and menu:

| # | Step | Expected |
|---|---|---|
| 7.1 | Upload a valid workbook | ✅ uploaded, then validated |
| 7.2 | Preview | ✅ per-row CREATE/UPDATE/UNCHANGED |
| 7.3 | Commit (confirmation required) | ✅ applied |
| 7.4 | Re-import the **same** workbook | ✅ all UNCHANGED; ❌ nothing rewritten |
| 7.5 | Upload a workbook with an invalid row | ✅ refused; ❌ nothing partially applied |
| 7.6 | Upload a non-`.xlsx` file | ✅ refused clearly |
| 7.7 | Upload a file over 10 MB | ✅ refused with 413 |
| 7.8 | Try to commit twice | ✅ second attempt refused |
| 7.9 | Import history | ✅ shows the batch, its counts and result |
| 7.10 | Menu import, then check status | ✅ imported days are **drafts** — ❌ importing must never publish |
| 7.11 | Offer a roster workbook as a menu import | ✅ refused on its contents |

---

## 8. Operational invariants

| # | Check | Expected |
|---|---|---|
| 8.1 | Draft menu | ❌ invisible to employees, unselectable |
| 8.2 | Published menu | ✅ visible and selectable |
| 8.3 | Archived menu | ❌ not offered |
| 8.4 | Roster change | ✅ eligibility changes immediately |
| 8.5 | Holiday | ✅ makes everyone ineligible for that date |
| 8.6 | Report counts | ✅ equal the selections actually made |
| 8.7 | Menu edit after selections exist | ✅ selections survive unchanged |
| 8.8 | Any API response | ❌ no `password_hash`, session token or stack trace |

---

## 9. Post-deployment health

| # | Check | Where |
|---|---|---|
| 9.1 | No unexpected 500s | `npx wrangler tail --env production` |
| 9.2 | No stuck imports | §4.1 of `RECOVERY.md` |
| 9.3 | Nightly maintenance ran | look for the `maintenance` log line after 03:17 UTC |
| 9.4 | D1 size reasonable | `npx wrangler d1 info canteenhub-prod --env production` |

---

## Failure protocol

Any ❌ observed is a rollback candidate. Roll the Worker back per §9 of
`DEPLOYMENT.md`, and remember that **a Worker rollback does not roll back D1** —
if the deployment applied a migration, read `RECOVERY.md` before doing anything
else.
