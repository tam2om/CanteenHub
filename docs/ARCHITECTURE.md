# CanteenHub — Architecture Proposal (Phase 0)

**Employee Meal Selection & Canteen Management System**

Status: **PROPOSAL — awaiting review and approval. No application code, no database tables, no dependencies installed.**

Date: 2026-09-09

---

## 0. Verified platform facts this design is built on

Every Cloudflare number below was read from official documentation during this discovery pass, not from memory. They are load-bearing: three of them changed the design.

| Constraint | Free plan | Paid ($5/mo) | Impact on CanteenHub |
|---|---|---|---|
| Worker CPU time per request | **10 ms** | 30 s (up to 5 min) | **Decisive.** No Excel parsing, no PDF generation, no heavy rendering in the Worker. |
| Worker requests/day | 100,000 | unlimited | Ample. ~150 employees × ~20 req/day ≈ 3,000/day. |
| **Static asset requests** | **free and unlimited, not counted** | same | Decisive. Favors a static SPA over server-side rendering. |
| D1 queries per Worker invocation | **50** | 1,000 | **Decisive.** Import commits must be chunked across requests. |
| D1 rows read / day | 5,000,000 | metered | Ample with correct indexes. |
| D1 rows written / day | **100,000** | metered | Ample, but a careless import (delete-all + re-insert) could approach it. |
| D1 max database size | 500 MB | 10 GB | Ample. Full 10-year history is single-digit MB. |
| D1 Time Travel retention | **7 days** | 30 days | Too short alone → we add R2 snapshots. |
| D1 `batch()` | atomic transaction; rolls back entirely on failure | same | This is our transaction primitive. No interactive `BEGIN`/`COMMIT`. |
| PBKDF2 iterations via WebCrypto | **capped at 100,000 by the platform** | same cap | Security ceiling we must design around (§15). |
| R2 free tier | 10 GB storage, 1M Class A, 10M Class B ops/month, free egress | same | Ample for original workbooks + nightly backups. |
| Workers Builds (Git → deploy) | connects GitHub, deploys on push | same | Our CI/CD. |

**Verdict on the free-tier goal: achievable**, with one caveat — the 10 ms CPU limit constrains password hashing strength (§15.2) and forbids server-side Excel work (§13). Both are designed around below. If the company later wants stronger password hashing, the $5/month Workers Paid plan removes the CPU constraint; nothing else in this architecture needs to change.

**Timezone:** Jordan is permanently **UTC+3 (Asia/Amman)** with no daylight saving since October 2022. This makes cutoff-time and "what is today" arithmetic simple — but the code will still resolve dates through `Intl.DateTimeFormat` with an `Asia/Amman` timezone stored in settings, never a hardcoded `+3` offset, so a future policy change is a settings edit rather than a code change.

---

## 1. Recommended frontend architecture

**Recommendation: a single Vite + React + TypeScript single-page application, built to static files, served directly by Cloudflare Workers Static Assets. No server-side rendering.**

### Why not SSR (Next.js / Remix / Astro SSR)?

Because static asset requests on Cloudflare are **free and never counted against the Workers request limit**, while every SSR page render burns from the 10 ms CPU budget and counts as a billable request. An SSR framework would spend our scarcest resource (CPU) to deliver a page that a static bundle delivers for free. For an internal app with ~150 users and no SEO requirement, SSR buys nothing and costs the thing we can least afford.

### Why one SPA rather than two apps?

One project, one deployment, one auth implementation, one shared TypeScript type package. The employee bundle stays small through **route-level code splitting**: the entire `/admin` tree — including the Excel library, the data grids, and the reporting UI — is a lazily-loaded chunk that an employee's phone never downloads.

This matters concretely: SheetJS is ~400 KB. Putting it in the employee bundle would violate the "few seconds to complete the task" requirement on a phone.

### Structure

```
Route                     Bundle          Audience
/login                    core            everyone
/                         core            employee — today's meal + selection
/menu                     core            employee — upcoming menus
/me                       core            employee — roster info, password change
/admin/*                  lazy chunk      admin only (also gated server-side)
```

### Employee screen — the primary design target

The requirement is "a few seconds." The home route must render the decision in one viewport with no scrolling on a typical phone:

1. Today's date and both meal options, with the common components (condiment, beverage, dessert) shown as informational text under them.
2. Three large tap targets: **Option 1**, **Option 2**, **No Preference**.
3. Current selection state and the cutoff time ("You can change this until 10:00").
4. If not eligible: no tap targets at all, replaced by a plain-language explanation and the next eligible date.

No dashboard, no charts, no navigation drawer on the primary screen. The employee opens the app, taps once, and is done.

### State and data fetching

- **TanStack Query** for server state — gives us caching, background refetch, and optimistic updates for the selection tap with automatic rollback on failure. The optimistic update is what makes the tap feel instant.
- **No Redux/Zustand.** There is essentially no client-side state that isn't server state. Adding a store would be ceremony.
- **React Router** for routing.

### Styling and accessibility

- **Tailwind CSS**, mobile-first. Utility classes keep the CSS bundle proportional to what is actually used.
- Semantic HTML: the three meal choices are a `<fieldset>` of radio inputs styled as cards — this gives keyboard navigation, screen-reader grouping, and native form semantics for free. Do not build them from `<div onClick>`.
- Target **WCAG 2.2 AA**: 4.5:1 contrast, 44×44 px minimum touch targets, visible focus rings, `aria-live` announcement when a selection is saved.
- **Never rely on colour alone** to signal selection state — pair colour with an explicit checkmark and text ("Selected"). Some employees will be colour-blind, and the selection state is the single most important piece of information on the screen.
- Full Arabic/RTL support is *not* proposed for Phase 1 but the layout should use logical CSS properties (`margin-inline-start`, not `margin-left`) so it remains cheap to add. See Open Question 3.

### Admin UI

Desktop-first, dense, table-driven. A persistent left navigation (Employees, Menu, Roster, Selections, Reports, Imports, Settings). Tables with server-side pagination, search, and filtering — never load all employees into the browser and filter client-side, because that pattern silently breaks as the company grows.

---

## 2. Recommended Cloudflare architecture

**One Worker. That is the whole deployment.**

```
                    ┌─────────────────────────────────────┐
   Browser ───────► │  Cloudflare edge (DNS, TLS, WAF)     │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │  canteenhub Worker                   │
                    │                                      │
                    │  /api/*  → Hono router (run first)   │
                    │  /*      → Static Assets (free)      │
                    └───┬───────────────┬──────────────┬───┘
                        │               │              │
                   ┌────▼────┐    ┌─────▼────┐   ┌─────▼──────┐
                   │ D1      │    │ R2       │   │ Cron       │
                   │ (SQLite)│    │ uploads +│   │ Trigger    │
                   │ all app │    │ backups  │   │ nightly    │
                   │ data    │    │          │   │ maintenance│
                   └─────────┘    └──────────┘   └────────────┘
```

### Configuration shape (`wrangler.jsonc`)

```jsonc
{
  "name": "canteenhub",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [{ "binding": "DB", "database_name": "canteenhub", "database_id": "..." }],
  "r2_buckets":   [{ "binding": "FILES", "bucket_name": "canteenhub-files" }],
  "triggers": { "crons": ["0 22 * * *"] }
}
```

`run_worker_first: ["/api/*"]` is the important line: the Worker script executes **only** for API calls. Every HTML, JS, CSS, and font request is served by the static asset layer without invoking the Worker at all — free, uncounted, and not subject to the CPU limit.

`not_found_handling: "single-page-application"` makes deep links like `/admin/reports/daily` serve `index.html` so client-side routing works on a hard refresh.

### Why Hono for the API router

Small (~15 KB), built for Workers, first-class TypeScript inference on route params and middleware context, and a middleware model that makes the authentication/authorization chain explicit and testable. The alternative — hand-rolled `URLPattern` matching — is more code to get wrong in exactly the place (authorization) where mistakes are most expensive.

### What we deliberately do NOT use

| Service | Why not |
|---|---|
| **Workers KV** | We considered it for sessions. Rejected: KV is eventually consistent, so a revoked session could remain valid for up to 60 seconds — unacceptable when the revocation reason is "this employee left the company." D1 gives strong consistency and a single indexed lookup is fast enough. |
| **Durable Objects** | No requirement needs single-point coordination. Selections are naturally partitioned per `(employee, date)` and a `UNIQUE` constraint plus `INSERT ... ON CONFLICT` handles concurrency correctly without them. Adding DOs would be complexity without a problem to solve. |
| **Queues** | Not on the free plan, and the import flow is designed to be chunked and client-driven (§13), which is simpler to reason about and gives the admin a live progress bar for free. |
| **Hyperdrive / external DB** | Explicitly out of scope per the technology direction, and unnecessary — the dataset is tiny. |
| **Cloudflare Access (Zero Trust)** | Optional and recommended as a *supplementary* layer if the company already uses it, but not as the primary auth: employees need a self-service password change and the app must own its own role model. Documented in §15.6. |

### Cron trigger (nightly, 22:00 UTC = 01:00 Amman)

One scheduled invocation per night that: purges expired sessions, writes the previous day's report snapshot (§14.3), exports a logical backup to R2 (§16), and prunes R2 backups past retention. Cron invocations get a 15-minute wall-clock budget rather than the 10 ms HTTP CPU limit, which is why the backup export lives here rather than in a request handler.

---

## 3. D1 database architecture

### Guiding principles

1. **Dates are stored as `TEXT` in `YYYY-MM-DD` form, always representing an Amman calendar date.** Not epoch integers, not `DATETIME`. SQLite has no date type; ISO date strings sort correctly lexicographically, compare correctly with `BETWEEN`, are readable in a database dump, and — critically — carry no timezone ambiguity. A meal date is a *calendar* concept, not an instant.
2. **Timestamps** (`created_at`, `updated_at`) are stored as `TEXT` ISO-8601 UTC (`2026-09-09T07:15:00Z`). These *are* instants and should be unambiguous globally.
3. **Enums are `TEXT` with a `CHECK` constraint,** not integers. `'option_1'` in a database dump is self-documenting; `2` is a bug waiting to happen during a data investigation.
4. **Foreign keys are declared and enforced** (`PRAGMA foreign_keys = ON`, which D1 applies by default). `ON DELETE RESTRICT` is the default posture — we want deletions to fail loudly rather than silently cascade into someone's meal history.
5. **Nothing operational is ever hard-deleted.** Employees deactivate, menus unpublish, roster entries supersede. The only rows we physically delete are expired sessions and, optionally, aged audit rows past a retention policy.
6. **Every table that can grow has an index supporting its hot query.** With a 5M rows-read/day budget and D1 counting *scanned* rows, a missing index on `lunch_selections(meal_date)` would turn a daily report into a full table scan.

The full proposed DDL is in [`schema.proposal.sql`](./schema.proposal.sql). It is a **proposal document, not a migration** — no tables are created until this architecture is approved.

### Table inventory

| Table | Purpose | Growth |
|---|---|---|
| `employees` | Identity, roster type, department, credentials | ~150 rows, stable |
| `roles` / `employee_roles` | Role assignment | tiny |
| `sessions` | Active login sessions | ~150, self-pruning |
| `menu_days` | One row per calendar day with a menu | ~250/year |
| `menu_options` | Exactly 2 per menu day | ~500/year |
| `menu_components` | Condiment/beverage/dessert per menu day | ~750/year |
| `roster_entries` | Daily shift value for Shift employees | ~30k/year worst case |
| `lunch_selections` | Current selection per employee per day | ~30k/year |
| `lunch_selection_history` | Append-only change log | ~35k/year |
| `holidays` | Non-working date overrides | ~15/year |
| `settings` | Key/value application config | ~10 rows |
| `import_batches` | One row per import attempt | ~50/year |
| `import_batch_rows` | Staged rows awaiting commit | transient, purged |
| `audit_log` | Append-only admin action log | ~5k/year |
| `daily_report_snapshots` | Frozen historical daily totals | ~250/year |

Total steady-state growth is roughly **5–10 MB per year** — comfortably inside the 500 MB free-tier database limit for the app's entire realistic lifetime.

---

## 4. Authentication and session architecture

### Identifier: AMCO ID + password

The requirements suggest an employee identifier, and AMCO ID is correct here. It already exists, every employee knows it, it is stable across name changes and department moves, and it appears on the employee's badge. Email is a worse choice for this population — not every canteen-eligible employee necessarily has a company mailbox, and using email would create a second identity that has to be kept in sync with HR data.

The login form field is labelled "AMCO ID," matching what is printed on the badge, not "username."

### Password storage

```
Format: pbkdf2$sha256$100000$<base64 salt>$<base64 hash>
```

- **PBKDF2-HMAC-SHA-256**, 100,000 iterations — the platform maximum; Cloudflare's WebCrypto refuses higher.
- 16 random bytes of salt per user, from `crypto.getRandomValues`.
- Verification uses a **constant-time comparison**, not `===`.
- The `pbkdf2$sha256$100000$` prefix is an **algorithm-agility marker**. When a stored hash's prefix does not match the current policy, the app transparently re-hashes the password at next successful login. This means moving to Argon2id later requires no password reset and no migration script.

**This is the weakest point in the security design and I want it flagged rather than buried** — see §15.2 for the full analysis and the compensating controls.

### Sessions: opaque server-side tokens, not JWTs

```
1. Login succeeds
2. Generate 32 random bytes → base64url → the session token
3. Store SHA-256(token) in `sessions` with employee_id, expires_at, created_at, ip, user_agent
4. Return Set-Cookie: ch_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=...
5. Every API request: hash the cookie, single indexed lookup, join to employee, check active
```

**Why not JWT?** Three reasons, in order of importance:

1. **Revocation must be instant.** When an employee is deactivated or an admin resets a password, every existing session must die *now*. A stateless JWT stays valid until it expires; the standard workaround is a server-side denylist, at which point you have a session table with extra steps and worse ergonomics.
2. **Cost is not a factor here.** The usual argument for JWTs is avoiding a database round-trip. Our database is a co-located SQLite file behind an indexed primary-key lookup, and we have a 5M rows/day read budget against maybe 3,000 requests. We are optimising a non-problem.
3. **Nothing to leak.** An opaque token carries no claims. A JWT in a browser is a readable, copyable, structured description of the user's role.

**Why hash the token at rest?** If a database backup or a Time Travel export leaks, the attacker holds SHA-256 digests, not live session tokens. Plain SHA-256 (no salt, no stretching) is correct here — the token is 256 bits of entropy, so there is nothing to brute-force, and we need the lookup to be a fast indexed equality match.

**Why `SameSite=Lax`?** It blocks CSRF on cross-site `POST` requests while keeping normal top-level navigation into the app working. Combined with the origin check in §15.3, this is our CSRF defence and it needs no token plumbing.

### Session lifetime

| Setting | Value | Why |
|---|---|---|
| Absolute expiry | 12 hours | Longer than a shift, short enough that a phone left in a locker isn't a standing risk. |
| Sliding renewal | Extend on use if >1 h remaining consumed | Avoids logging someone out mid-selection. |
| Admin session expiry | 8 hours | Tighter, because the blast radius is larger. |
| On password change | All *other* sessions revoked | Standard, and it's the user's remediation path if they suspect compromise. |
| On deactivation / admin reset | All sessions revoked immediately | The revocation requirement above. |

### First login and password reset

Employees imported from Excel have **no password and no usable login** until one is issued. An admin action generates a high-entropy temporary password, displays it exactly once, and sets `must_change_password = 1`. Any authenticated request other than "change my password" is refused with `403 PASSWORD_CHANGE_REQUIRED` until it is done — enforced in middleware, server-side, not by hiding a screen.

There is deliberately **no self-service password reset** in Phase 1: it would require an email or SMS channel we do not have and would be the single most attackable surface in the app. An employee who forgets their password asks the canteen administrator, who is a person they can find. See Open Question 5.

---

## 5. Authorization model

### Roles

| Role | Can do |
|---|---|
| `employee` | Read own selection, own eligibility, published menus. Write own selection (within eligibility + cutoff). Change own password. |
| `admin` | Everything an employee can, plus: read/write employees, menus, roster, imports, reports. Reset employee passwords. |
| `super_admin` | Everything an admin can, plus: change application settings, grant/revoke roles, and **override an employee's selection after the cutoff**. |

**Why a third role?** The requirements say "allow *authorized* admin correction/override," which implies not every admin should hold it. Post-cutoff override is the one action that changes an operational number after the catering order is placed — it deserves a narrower grant and a louder audit entry. Roles are stored in a table rather than as a column so a fourth role (a read-only "kitchen display" account, say) needs no schema change.

### Enforcement: three independent layers, server-side

**Layer 1 — Route middleware.** Every route is registered under a guard. There is no unguarded route by default; the router mounts `/api/admin/*` behind `requireRole('admin')` as a group, so adding a new admin endpoint inherits the guard rather than needing to remember it.

**Layer 2 — Query scoping.** Employee-facing handlers never accept an employee ID from the client. The identity comes from the session, and the SQL is written as `WHERE employee_id = ?1` with the session's ID bound. There is no code path where a client-supplied employee ID reaches a WHERE clause on an employee route. This is what makes "employee A cannot read employee B's selection" a structural property rather than a check someone might forget.

**Layer 3 — Domain rules.** Even a correctly authenticated, correctly authorized employee is refused if they are not eligible, if the menu is unpublished, or if the cutoff has passed. These are enforced in a single service function that every write path calls (§12), not re-implemented per endpoint.

**The UI hides buttons only as a courtesy.** Hiding the admin nav is a usability affordance, never a control. Every one of these checks is repeated server-side on every request, and the integration test suite asserts it by calling admin endpoints with an employee session and expecting `403` (§19).

---

## 6. Data model — entities and relationships

```
                            ┌──────────────┐
                            │   employees  │
                            │──────────────│
                            │ id (PK)      │
                            │ amco_id (UQ) │
                            │ full_name    │
                            │ department   │
                            │ section      │
                            │ roster_type  │◄── 'regular' | 'shift' | 'amman_hq'
                            │ is_active    │
                            │ password_hash│
                            └──┬────┬───┬──┘
                               │    │   │
        ┌──────────────────────┘    │   └──────────────────┐
        │                           │                      │
┌───────▼─────────┐   ┌─────────────▼──────┐   ┌───────────▼────────┐
│ roster_entries  │   │  lunch_selections  │   │  employee_roles    │
│─────────────────│   │────────────────────│   │────────────────────│
│ employee_id  FK │   │ employee_id     FK │   │ employee_id     FK │
│ work_date       │   │ meal_date          │   │ role            FK │
│ shift_value     │   │ choice             │   └────────────────────┘
│ UNIQUE(emp,date)│   │ UNIQUE(emp,date)   │
└─────────────────┘   └─────────┬──────────┘
  'day'|'night'|'off'           │
                                │ (append-only)
                      ┌─────────▼──────────────────┐
                      │ lunch_selection_history    │
                      └────────────────────────────┘

┌──────────────┐        ┌──────────────────┐
│  menu_days   │───1:2─►│  menu_options    │  option_number 1 or 2
│──────────────│        └──────────────────┘
│ id (PK)      │
│ meal_date UQ │───1:N─►┌──────────────────┐
│ status       │        │ menu_components  │  condiment | beverage |
│ published_at │        └──────────────────┘  dessert | salad | soup | other
└──────────────┘

┌──────────┐  ┌──────────────────┐  ┌───────────┐  ┌───────────────────────┐
│ holidays │  │  import_batches  │  │ audit_log │  │ daily_report_snapshots│
└──────────┘  └────────┬─────────┘  └───────────┘  └───────────────────────┘
                       │ 1:N
              ┌────────▼──────────┐
              │ import_batch_rows │  (staging — validated, not yet committed)
              └───────────────────┘

┌──────────┐
│ settings │  key/value: cutoff_time, working_days, timezone, ...
└──────────┘
```

### The one relationship that is deliberately absent

**`lunch_selections` has no foreign key to `menu_days` or `menu_options`.** A selection stores `meal_date` and `choice ∈ {option_1, option_2, no_preference}` — it references the *slot*, not the menu row.

This is the single most important modelling decision in the document, because it is what makes "a menu re-import must not destroy existing selections" true by construction rather than by careful coding. If the admin re-imports Wednesday's menu and Option 1 changes from "Grilled Chicken" to "Roast Chicken," every employee who chose Option 1 still has a valid, intact selection. There is no cascade to guard against, no repair script to write, and no way for a future developer to accidentally introduce one.

The trade-off is that a selection does not record *what the food was* at the time of choosing. That is recovered for historical reporting by the daily snapshot (§14.3), which freezes the menu text alongside the totals — so we keep the history without coupling the tables.

---

## 7. Menu model

### Three tables, not one

```sql
menu_days(id, meal_date UNIQUE, status, published_at, notes, created_at, updated_at)
menu_options(id, menu_day_id, option_number CHECK IN (1,2), name, description)
menu_components(id, menu_day_id, component_type, name, sort_order)
```

**Why not one wide `menu_days` table** with `option_1_name`, `option_2_name`, `condiment`, `beverage`, `dessert` columns? It looks simpler and it is the obvious translation of the spreadsheet. It is wrong for two reasons:

1. **The component list is open.** The September 2026 workbook has condiment, beverage, and dessert/fruit. Next quarter's menu may add soup or salad. In the wide model that is a schema migration; in the normalized model it is a new row with a different `component_type`. The requirement explicitly says not to simplify in a way that prevents preserving these details.
2. **Options need structure.** Each option has a name and a description, and will plausibly grow attributes (vegetarian flag, allergen list, photo). Two columns become six become twelve.

**Why is `option_number` constrained to exactly 1 or 2?** Because the business rule is "two options per day," and the requirement is explicit. Encoding it as a `CHECK` plus `UNIQUE(menu_day_id, option_number)` means the database itself refuses a malformed import. If the company ever offers three options, that is a deliberate migration and a deliberate change to the employee UI — not something an importer should be able to do by accident.

**Why is `no_preference` not a `menu_options` row?** Because it is not food. It is the absence of a preference, meaningful to the caterer (any portion will do) but not a menu item. Modelling it as an option would corrupt every "how many portions of each dish" query.

### Menu lifecycle

```
draft ──publish──► published ──unpublish──► draft
                       │
                       └──(date passes)──► historical (immutable in practice)
```

- **`draft`** — visible to admins only. Imports land here. Employees cannot see it and cannot select against it.
- **`published`** — visible to employees; selections are open (subject to eligibility and cutoff).
- Unpublishing a day that already has selections is permitted but **warns** with the affected count and writes an audit entry. It does not delete selections.
- **Historical preservation:** past menu days are never deleted or edited by the importer. An import that targets a past date is rejected at validation with an explicit error unless a super_admin sets an "allow historical correction" flag on that specific batch — and if they do, the change is audited with before/after JSON.

### Upcoming menus for employees

Employees see published menus for today plus the next N days (`upcoming_menu_days` setting, default 7). They can see the food but can only *select* for dates they are eligible for and where the cutoff has not passed. Advance selection for future dates is proposed as **allowed** — it costs nothing, helps shift workers who won't be online tomorrow morning, and the cutoff still governs the final answer. See Open Question 2.

---

## 8. Employee model

```sql
employees(
  id                    INTEGER PK,
  amco_id               TEXT UNIQUE NOT NULL,   -- business key from HR
  full_name             TEXT NOT NULL,
  department            TEXT,
  section               TEXT,
  roster_type           TEXT NOT NULL CHECK (roster_type IN ('regular','shift','amman_hq')),
  is_active             INTEGER NOT NULL DEFAULT 1,
  password_hash         TEXT,                   -- NULL until a password is issued
  must_change_password  INTEGER NOT NULL DEFAULT 1,
  password_changed_at   TEXT,
  last_login_at         TEXT,
  failed_login_count    INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  created_at, updated_at, created_by, updated_by
)
```

### Why a surrogate `id` when `amco_id` is already unique?

Because business keys change. If HR ever re-issues, re-formats, or corrects an AMCO ID, an integer primary key means updating one row instead of rewriting every roster entry, selection, and history record that referenced it. `amco_id` carries a `UNIQUE` index and is what the importer matches on; `id` is what the rest of the schema joins to.

### Why `roster_type` is a `TEXT` enum on the employee

The three roster types are the central branching rule of the whole system (§12). Making it an explicit, constrained, self-documenting column on the employee — rather than inferring it from the presence of roster rows — means:

- The eligibility function reads it directly and branches once.
- A `CHECK` constraint makes an invalid import value a database error rather than an employee silently losing their meals.
- `SELECT roster_type, COUNT(*) FROM employees GROUP BY roster_type` answers "how many Amman HQ staff do we have" instantly.

**`amman_hq` is a roster type, not a department.** This is worth stating explicitly because the workbook has both a Department column and a Roster column, and it would be a natural mistake to derive meal eligibility from `department = 'Amman HQ'`. Eligibility must key off `roster_type` only. Department is reporting metadata; it must never affect eligibility. If someone in the Amman HQ department transfers to a shift role, their `roster_type` changes and their meals begin — driven by the roster column, not by where they sit.

### Why `is_active` instead of deleting

An employee who leaves must stop being able to log in and must disappear from tomorrow's catering count — but last month's report must still show that they took Option 2 on the 14th. Deactivation satisfies all three. Deletion would either destroy history or fail on a foreign key. Deactivation also revokes their sessions immediately (§4).

### Department and section

Free-text `TEXT` columns in Phase 1, taken from the workbook. **Not** foreign keys to a `departments` table, because the workbook is the source of truth and the values arrive as strings; introducing a lookup table now would mean the importer has to invent departments on the fly, which is exactly the kind of silent data creation an import should not do. Department totals in reports come from `GROUP BY department` with a supporting index. If department management becomes a real requirement, promoting these to a lookup table is a contained later migration.

---

## 9. Roster model

```sql
roster_entries(
  id           INTEGER PK,
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  work_date    TEXT NOT NULL,              -- 'YYYY-MM-DD'
  shift_value  TEXT NOT NULL CHECK (shift_value IN ('day','night','off')),
  source       TEXT NOT NULL CHECK (source IN ('import','manual')),
  import_batch_id INTEGER REFERENCES import_batches(id),
  created_at, updated_at, updated_by,
  UNIQUE (employee_id, work_date)
)
```

Plus an append-only `roster_entry_history` recording every change (old value, new value, actor, batch, timestamp) — the requirement asks to "review roster changes" and "preserve roster history," and a mutable current-value table alone cannot answer "who moved Ahmad from Night to Off on the 12th, and when."

### Why one row per employee per day rather than a wide month-shaped table

The September 2026 workbook is almost certainly laid out as one row per employee with 30 date columns. That is a *presentation* shape, not a storage shape. Storing it long-form gives us:

- `UNIQUE(employee_id, work_date)` — a genuine guarantee of one shift per person per day, enforced by the database.
- Trivial queries for "who is on Night this Thursday" and "show me this employee's month."
- Month boundaries that don't matter. A roster covering 15 Sep – 15 Oct is just rows.
- An importer that can safely upsert a single day without rewriting a whole row.

The importer's job is to pivot the wide sheet into long rows. That pivot happens in the browser (§13), where CPU is free.

### Which employees get roster rows

Only `roster_type = 'shift'` employees. This is enforced at import validation: a roster row for a `regular` or `amman_hq` employee is a **validation error**, surfaced in the preview, not silently accepted. Accepting it would create data that looks meaningful but that the eligibility function ignores — the worst kind of data, because it makes the system look wrong when it is right.

### The critical rule: a missing roster entry is NOT eligibility

For a `shift` employee, absence of a `roster_entries` row for a date means **"roster not published for this date,"** not "off" and not "working." The system must say so plainly to the employee ("Your shift roster for this date hasn't been published yet") and must count them in the report as *not eligible — roster missing*, distinctly from *not eligible — off*.

This distinction is what turns a silent data gap into an actionable one. If forty shift employees show "roster missing" for next Tuesday, the administrator sees a report line telling them the roster import is late — rather than under-ordering forty meals and finding out at lunchtime.

### Regular and Amman HQ employees have no roster rows

`regular` eligibility is computed from the `working_days` setting (default Sunday–Thursday) minus `holidays`. `amman_hq` is never eligible. Neither consults `roster_entries`, so neither needs rows — which also keeps the table at ~30k rows/year rather than triple that.

---

## 10. Lunch selection model

```sql
lunch_selections(
  id             INTEGER PK,
  employee_id    INTEGER NOT NULL REFERENCES employees(id),
  meal_date      TEXT NOT NULL,
  choice         TEXT NOT NULL CHECK (choice IN ('option_1','option_2','no_preference')),
  selected_at    TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('employee','admin_override','system')),
  set_by         INTEGER REFERENCES employees(id),   -- the actor; = employee_id for self-service
  override_reason TEXT,                              -- required when source = 'admin_override'
  created_at, updated_at,
  UNIQUE (employee_id, meal_date)
)
```

### Why `UNIQUE(employee_id, meal_date)` and upsert rather than append

An employee has exactly one current answer for a day. Modelling the current state as one row makes the two hot queries — "what did I pick?" and "count portions for today" — single indexed reads with no window functions or `MAX(created_at)` subqueries. The change *history* lives in its own append-only table where it belongs. This keeps the operational table small and the reporting query trivial, which matters directly against D1's rows-scanned accounting.

The write is a single statement:

```sql
INSERT INTO lunch_selections (employee_id, meal_date, choice, ...)
VALUES (?1, ?2, ?3, ...)
ON CONFLICT (employee_id, meal_date)
DO UPDATE SET choice = excluded.choice, selected_at = ..., updated_at = ...;
```

Atomic, race-free, one round trip. Two rapid taps from a flaky mobile connection cannot produce two rows.

### `lunch_selection_history` — append-only, never updated

```sql
lunch_selection_history(
  id, employee_id, meal_date,
  previous_choice TEXT,        -- NULL on first selection
  new_choice TEXT,
  changed_at, changed_by, source, override_reason, ip_address
)
```

Every insert and every update to `lunch_selections` writes a history row **in the same `batch()`** so the two cannot diverge. This is our answer to "preserve an audit trail of admin changes" for the selection domain specifically, and it also gives employees a defensible record ("I did change it before the cutoff").

### `source` and why admin overrides are distinguishable

A caterer's count and a dispute investigation need to know whether a selection was made by the employee or written by an administrator. `source = 'admin_override'` with a mandatory `override_reason` makes every such row self-explaining, and the daily report can surface "3 selections were set by an administrator" as a line item rather than hiding it inside the totals.

### The cutoff rule

- **Before cutoff:** an eligible employee may create or change their selection freely.
- **After cutoff:** the write is refused with `403 CUTOFF_PASSED`. The UI disables the buttons *and* the server refuses — the server check is the real one.
- **`super_admin` may still write** after the cutoff, but only through the override endpoint, only with a reason, and it is always `source = 'admin_override'`.

Cutoff comparison is done in Amman local time: the server formats "now" into the `Asia/Amman` calendar date and clock time and compares against the `cutoff_time` setting for the *meal date in question*. For future dates the cutoff has definitionally not passed.

### Selections that become orphaned

If a roster import later makes an employee ineligible for a date they already selected, the selection is **retained, never deleted** (§11). It is flagged as orphaned by the eligibility function at read time — no stored flag, so it self-heals if the roster is corrected again — and it appears in a "selections requiring review" list for the admin. The catering count excludes orphaned selections; the reconciliation report names them. Deleting them would silently change a number an administrator may already have acted on.

---

## 11. Import and audit model

### The import state machine

```
  uploaded ──► validated ──► previewed ──► committing ──► committed
     │             │                            │
     └──► failed ◄─┘                            └──► partially_committed
                        (any state) ──► cancelled
```

```sql
import_batches(
  id, import_type CHECK IN ('employees','roster','menu'),
  status CHECK IN ('uploaded','validated','previewed','committing','committed',
                   'partially_committed','failed','cancelled'),
  original_filename, r2_object_key, file_sha256,
  uploaded_by, uploaded_at,
  row_count, new_count, updated_count, unchanged_count, error_count, conflict_count,
  committed_by, committed_at,
  committed_row_count,          -- for resumable chunked commit
  summary_json, error_json,
  created_at, updated_at
)

import_batch_rows(
  id, import_batch_id, row_number,
  raw_json,                     -- exactly what the sheet said
  normalized_json,              -- what we will write
  action CHECK IN ('create','update','unchanged','error','conflict'),
  messages_json,                -- per-row errors/warnings
  target_entity_id,             -- resolved existing row, if any
  is_committed INTEGER DEFAULT 0
)
```

### Rule 1 — an import never deletes

There is no code path in any importer that issues a `DELETE`. Not for employees, not for roster entries, not for menu days, and above all not for selections. This is a structural rule, asserted by a test that greps the importer modules, because "the import wiped last month's data" is the failure mode that destroys trust in a system like this permanently.

Absence from a sheet is **not** an instruction to delete:

| Situation | Behaviour |
|---|---|
| Employee in DB, absent from the sheet | Left untouched. Reported as "not present in file: N employees." The admin may *separately and explicitly* choose "deactivate employees missing from this file" — a distinct, confirmed, audited action, never the default. |
| Roster date in DB, absent from the sheet | Left untouched. Roster imports are additive/upsert per `(employee, date)`. |
| Menu day in DB, absent from the sheet | Left untouched. |

### Rule 2 — validate and preview before anything is written

The admin never commits blind. The preview screen shows:

```
  New records:        12
  Updated records:    148
  Unchanged:          31
  Errors:              2   ← blocking; must be fixed or the rows excluded
  Conflicts:           4   ← require an explicit decision
  Impact on existing selections:
      • 3 employees have selections on dates this roster marks 'off'
      • 1 menu day being changed already has 47 selections
```

The staged rows live in `import_batch_rows` between validation and commit, so the preview reflects exactly what will be written — not a re-parse that might differ.

### Rule 3 — impact analysis is part of validation

Before commit, the validator runs the eligibility function against the *proposed* data and diffs it against existing selections. Any employee who would lose eligibility on a date where they already selected is reported by name. Any menu day being modified reports its existing selection count. The admin sees the human consequence of the import before it happens, which is the entire point of the preview stage.

### Rule 4 — commit is atomic per chunk and resumable

Because of D1's **50 queries per invocation** free-tier limit, a 150-employee roster covering 30 days (4,500 rows) cannot commit in one request. The commit is chunked:

- Rows are grouped into multi-row `INSERT ... ON CONFLICT DO UPDATE` statements of ~200 rows each (bounded by the 100 KB statement-length limit and the 100 bound-parameter limit — so parameters are batched carefully, or values are inlined after strict validation and escaping).
- A handful of such statements plus the batch-progress update go into one `batch()` — **atomic**, so a chunk either lands entirely or not at all.
- `committed_row_count` advances with each chunk *inside the same batch*, so a network failure leaves a resumable, never a corrupted, batch.
- The admin UI drives the chunks sequentially and shows a progress bar. If the browser closes mid-commit, the batch sits in `committing` and can be resumed or rolled back from the imports screen.

Status `partially_committed` exists precisely so this state is visible and nameable rather than being an inconsistency nobody notices.

### Rule 5 — every import is permanently traceable

- The **original uploaded file** is stored in R2 under `imports/{batch_id}/{filename}` with its SHA-256 recorded. Months later, "what exactly did the file say?" is answerable from the artifact, not from someone's memory. This also guards the client-side-parsing decision (§13): the authoritative bytes are retained even though the parse happened in a browser.
- `import_batches` rows are kept forever. Their counts and summaries are the import history screen.
- `import_batch_rows` are purged after a retention window (30 days) by the nightly cron, since the file in R2 and the summary remain.
- Every row written by an import carries `import_batch_id`, so "which import created this roster entry?" is a column lookup.

### The general audit log

```sql
audit_log(
  id, actor_employee_id, actor_role, action, entity_type, entity_id,
  before_json, after_json, ip_address, user_agent, created_at
)
```

Append-only. Written in the **same `batch()`** as the change it records, so an audited action cannot succeed without its audit row. Covers: employee create/update/activate/deactivate, password reset, role change, menu create/edit/publish/unpublish, roster edit, selection override, settings change, and import commit/cancel.

Deliberately **not** logged: employee self-service selections (they have their own richer history table) and read operations (a read log for a 150-person internal app is noise that would dominate the write budget).

---

## 12. Eligibility calculation design

This is the heart of the system, so it gets the strictest treatment: **one pure function, one place, no duplication.**

```ts
type Eligibility =
  | { eligible: true;  reason: 'regular_working_day' | 'shift_day' | 'shift_night' }
  | { eligible: false; reason: EligibilityDenialReason; nextEligibleDate: string | null };

type EligibilityDenialReason =
  | 'amman_hq'             // roster type never receives a company meal
  | 'regular_weekend'      // Friday or Saturday for a Regular employee
  | 'holiday'              // company holiday
  | 'shift_off'            // rostered 'off'
  | 'roster_missing'       // Shift employee, no roster row published for this date
  | 'employee_inactive';   // deactivated

function computeEligibility(
  employee: { rosterType: RosterType; isActive: boolean },
  mealDate: string,                       // 'YYYY-MM-DD', Amman calendar date
  rosterEntry: RosterEntry | null,
  settings: { workingDays: number[]; timezone: string },
  holidays: Set<string>
): Eligibility
```

### Why a pure function with injected data

It takes no database handle, does no I/O, and reads no clock. Therefore:

- It is **exhaustively unit-testable** — every roster type × every weekday × holiday × roster-value combination is a table-driven test with no fixtures, no mocking, and no database. This is the single highest-value test surface in the project and it must be exercised to 100% branch coverage.
- It is **usable in three contexts with identical results**: the employee's live screen, the report generator, and the import impact analyser. A bug cannot manifest in the report but not the UI.
- It **cannot drift**. Callers load data; the function decides. There is no second implementation to keep in sync.

### The decision order (order matters)

```
1. employee.isActive == false        → not eligible: employee_inactive
2. rosterType == 'amman_hq'          → not eligible: amman_hq
3. mealDate ∈ holidays               → not eligible: holiday
4. rosterType == 'regular':
       weekday(mealDate) ∈ workingDays  → ELIGIBLE  (regular_working_day)
       else                             → not eligible: regular_weekend
5. rosterType == 'shift':
       rosterEntry == null              → not eligible: roster_missing
       shift_value == 'day'             → ELIGIBLE  (shift_day)
       shift_value == 'night'           → ELIGIBLE  (shift_night)
       shift_value == 'off'             → not eligible: shift_off
```

**`amman_hq` is checked before the calendar**, so an Amman HQ employee is told the honest reason ("Amman HQ employees do not receive a company meal") on every day of the week, rather than being told it is the weekend on Friday and something else on Monday. The reason an employee sees should be stable and true, not incidental.

**`roster_missing` is a first-class outcome**, never collapsed into `shift_off`. See §9 for why this distinction is operationally load-bearing.

**Both `day` and `night` are eligible.** This is stated explicitly in the requirements and is the kind of rule that a future maintainer might "helpfully" question, so the code comment and the test names should both carry it: night-shift employees receive a meal.

**No rule is invented.** There is no seniority logic, no probation rule, no partial-day rule, no location rule beyond the three roster types. The function's branch list above is complete.

### `nextEligibleDate`

Computed by walking forward day by day from the meal date, evaluating the same function, up to a bounded horizon (`lookahead_days` setting, default 14):

- **Regular:** deterministic — the next configured working day that is not a holiday. Always resolvable.
- **Shift:** resolvable only as far as the published roster reaches. Beyond that we return `null` and the UI says "Your next meal date depends on your published shift roster" rather than inventing a date. Guessing here would be worse than admitting the limit.
- **Amman HQ:** always `null`, and the UI does not show a "next date" line at all, because there isn't one and showing an empty field implies there might be.

The walk is bounded and reads from an already-loaded holiday set and a single roster query for the horizon, so it costs one extra indexed query — well inside the CPU and query budgets.

### Weekday numbering

`working_days` is stored as a JSON array of JavaScript `getDay()` numbers — `[0,1,2,3,4]` meaning Sunday, Monday, Tuesday, Wednesday, Thursday. Sunday is 0, matching the platform's native numbering so no conversion layer exists to be wrong. The default matches the Regular rule exactly: Sunday–Thursday eligible, Friday (5) and Saturday (6) not.

The weekday is derived from the date string using `Intl.DateTimeFormat` with the configured timezone, **never** from `new Date(str).getDay()` on a bare date string — that path is UTC-parsed and would place a date in the wrong day near midnight. This is a small detail with a large failure mode, and it belongs in one shared date utility that everything calls.

---

## 13. Excel import strategy

### The decision: parse in the browser, validate on the server

**Excel files are parsed client-side in the administrator's browser using SheetJS. The Worker never parses a workbook.**

#### Why

The Worker has **10 ms of CPU per request on the free plan**. Parsing a 4,500-cell XLSX with SheetJS is tens to hundreds of milliseconds of CPU — it would fail, every time, and no amount of optimisation closes a 10× to 100× gap. The alternatives were:

| Option | Verdict |
|---|---|
| Parse in the Worker | **Impossible on free tier.** Would force the paid plan for a problem that has a better solution anyway. |
| Upload to R2, parse in a Queue consumer | Queues are not on the free plan; adds a service, async status polling, and a failure mode, to do work the browser can do instantly. |
| **Parse in the browser, send normalized JSON** | **Chosen.** Zero server CPU, instant feedback, no extra service, and the admin is on a desktop with abundant CPU. |

Beyond fitting the constraint, this is genuinely the better design: the admin sees parse errors in milliseconds instead of after an upload round trip, and the file never needs to travel before it is known to be readable.

#### The security question this raises, and its answer

Client-side parsing means the server receives **JSON from a browser, which is untrusted input** — a malicious or buggy client could send anything. This does not weaken the system, because the server was always going to be the validator:

- Every field is re-validated server-side: `amco_id` format, `roster_type` against the enum, dates against `YYYY-MM-DD` and a sane range, `shift_value` against the enum, `option_number ∈ {1,2}`, string lengths, row counts.
- Every referential fact is re-checked against the database: does this AMCO ID exist? Is this employee `shift` type? Does this date already have selections?
- All authorization is server-side and unchanged.
- **The original file is uploaded to R2 regardless**, streamed through the Worker (streaming a body to R2 costs almost no CPU — it is I/O, not computation). So the authoritative artifact is retained and any dispute is resolved against the bytes the admin actually uploaded, not against the JSON their browser produced.

The client is a convenience for *parsing*; it is never a source of *truth*.

### Flow

```
1. Admin selects file
2. Browser: SheetJS parses → detects sheet/header layout → pivots to long form
3. Browser: POST multipart → Worker streams the original file to R2,
            creates import_batches row (status='uploaded')
4. Browser: POST normalized rows in chunks → /api/admin/imports/{id}/rows
            Worker validates each row and writes import_batch_rows
5. Worker: runs cross-row + database validation and impact analysis
            → status='validated'
6. Admin: reviews the preview screen (new/updated/unchanged/errors/conflicts/impact)
7. Admin: confirms → repeated POST /api/admin/imports/{id}/commit?offset=N
            each call commits one chunk inside a single atomic batch()
8. status='committed'; audit_log entry written; import_batch_rows purged after 30 days
```

### Column mapping: explicit, not guessed

Each import type has a declared mapping from expected header text to internal field, with a small set of accepted aliases (case- and whitespace-insensitive, so `AMCO ID#`, `amco id #`, and `AMCO_ID` all resolve).

If a required column is missing, the import **stops at parse time with a clear message naming the missing column** and shows the headers it did find. It never guesses by column position — a silently mis-mapped column that puts department values into the roster field is exactly the kind of failure that reaches production looking fine.

**These mappings will be finalized against the actual workbooks.** The three files described in the requirements (employees, September 2026 roster, September 2026 menu) are **not present in this repository** — see Open Question 1. The mapping layer is deliberately isolated in `src/shared/import/mappings/` so that adapting to the real headers is a single-file change per import type, not a refactor.

### Per-type notes

**Employees** — matched on `amco_id`. New AMCO ID → `create`. Existing with differences → `update` (diff shown field by field). Existing and identical → `unchanged`. Invalid `roster_type` → `error` with the offending value quoted. Imports never set or clear passwords, and never change `is_active` except through the separate explicit action described in §11.

**Roster** — the wide month sheet is pivoted in the browser into `(amco_id, work_date, shift_value)` triples. Unknown AMCO ID → `error`. Employee is not `shift` type → `error`. Unrecognised shift value → `error` with the raw cell text shown (real sheets contain `D`, `N`, `OFF`, blanks, and stray spaces; the mapping normalizes a documented alias set and rejects the rest rather than guessing). A blank cell is reported as *no entry* — it is not silently converted to `off`, per §9.

**Menu** — each day yields one `menu_days` row, exactly two `menu_options`, and N `menu_components`. Fewer or more than two options is an `error`, not a silent accept. Imports land as `draft` and require an explicit publish step, so a wrong import is never visible to employees. A date that already has selections is flagged as a `conflict` with the count.

### Export for round-tripping

The admin can export employees, roster, and menu in exactly the layout the importer expects. This gives a safe edit-and-reimport workflow and doubles as an offline backup an administrator can keep. Export files are also generated **client-side** with SheetJS, for the same CPU reason.

---

## 14. Report and export architecture

### 14.1 Reports are SQL aggregates, not application loops

Every report is a `GROUP BY` executed in D1, returning tens of rows rather than thousands. The daily summary is one query per section, all issued in a single `batch()`:

```sql
-- Portion counts (this drives the catering order)
SELECT choice, COUNT(*) FROM lunch_selections
WHERE meal_date = ?1 GROUP BY choice;
```

Eligibility, however, cannot be a pure SQL aggregate — it depends on the branching rules in §12. The daily report therefore loads active employees plus the day's roster entries (two indexed queries, ~300 rows) and runs the **same `computeEligibility` function** the UI uses over them in memory. At ~150 employees this is microseconds of CPU and stays far inside the 10 ms budget, and it guarantees the report and the employee's screen can never disagree.

### 14.2 The report vocabulary

The example in the requirements defines the contract precisely:

```
Option 1:                      48
Option 2:                      52
No Preference:                  7
Eligible but not selected:      3
Not eligible:                  23
```

- **Catering quantity = actual selections only.** Option 1 = 48 portions, Option 2 = 52 portions, and the 7 No Preference are portions the caterer may fill with either. "Eligible but not selected" is **not** added to any dish count — those 3 people are a follow-up action for the administrator, not an order line.
- **"Not eligible" is broken down** in the detailed view by the reason enum from §12 — `amman_hq`, `regular_weekend`, `shift_off`, `roster_missing`, `holiday`, `employee_inactive` — because "23 not eligible" is a number, while "18 Amman HQ, 4 off, **1 roster missing**" is information the administrator can act on.
- Every count is clickable through to the named employee list, because the requirement asks for employee-level visibility and because a total nobody can drill into is a total nobody trusts.

### 14.3 Snapshots: freezing history

The nightly cron writes a `daily_report_snapshots` row for the previous day containing the final totals, the per-reason breakdown, and the menu text as published.

**Why:** roster corrections, employee deactivations, and menu edits are all legitimate future events that would silently rewrite a recomputed historical report. If March's report is regenerated in June and shows different numbers than the one the caterer was paid against, the system has lost its usefulness as a record. The snapshot is what the day actually was.

Historical reports read the snapshot. Today's report is always live. A recomputed historical view remains available side by side, clearly labelled, for investigating discrepancies.

### 14.4 The report set

| Report | Contents |
|---|---|
| **Daily summary** | The five-line summary above, plus not-eligible reason breakdown and admin-override count. |
| **Daily detail** | Every employee: AMCO ID, name, department, section, roster type, eligibility, reason, selection, source. |
| **Monthly summary** | Per-day totals across the month; per-department totals; participation rate. |
| **Eligible but not selected** | Named list for follow-up. |
| **Not eligible** | Named list grouped by reason. |
| **Department totals** | `GROUP BY department, choice` — the meaningful cut for cost allocation. |
| **Selection changes** | From `lunch_selection_history` — who changed what, when, and admin overrides with reasons. |
| **Import history** | From `import_batches` — what was imported, by whom, with what impact. |

### 14.5 Export formats

| Format | Generated where | Why |
|---|---|---|
| **Excel (.xlsx)** | **Browser**, SheetJS, from the report JSON | Same 10 ms CPU constraint as import. The admin is on a desktop; generation is instant and costs the platform nothing. Also lets us produce a properly formatted multi-sheet workbook, which is what an administrator actually wants. |
| **CSV** | Server or browser | Trivial string concatenation. Server-side is fine and gives a clean download URL. UTF-8 BOM prefixed so Excel opens Arabic names correctly — a small detail with a very visible failure mode. |
| **PDF / print** | **Browser print stylesheet** (`@media print`) → the user's own Print-to-PDF | A PDF library in the Worker is impossible under 10 ms, and shipping one to the browser costs ~1 MB for a job the browser already does natively and well. A dedicated print layout gives a clean, headed, paginated document with no dependency at all. |

There is no server-side rendering of any export. Every heavy format is produced where CPU is free.

---

## 15. Security model

### 15.1 Threat model

This is an internal, low-value-target application, but the realistic threats are worth naming so the controls are proportionate:

| Threat | Control |
|---|---|
| Employee views/changes another employee's selection | Session-derived identity only; no client-supplied employee ID on employee routes (§5, Layer 2). |
| Employee reaches admin functionality | Server-side role guard on every admin route; tested explicitly. |
| Credential stuffing / brute force | Rate limiting, account lockout, generic error messages (§15.2). |
| Stolen laptop / shared browser | `HttpOnly` cookies, 8–12 h expiry, immediate revocation on deactivation. |
| Malicious or malformed import | Server-side re-validation of every field; preview before commit; no deletes; original file retained. |
| Insider misuse (admin sets a selection quietly) | Mandatory reason on override, audit log, override count surfaced in the daily report. |
| Data leak via backup | Session tokens stored hashed; passwords stored hashed; backups access-controlled in R2. |

### 15.2 The password hashing constraint — stated plainly

Cloudflare's WebCrypto implementation **refuses PBKDF2 above 100,000 iterations**, and the free plan's 10 ms CPU budget makes even that tight. OWASP's current guidance for PBKDF2-SHA-256 is 600,000 iterations. **We cannot reach that on this platform.**

**Recommendation: PBKDF2-SHA-256 at 100,000 iterations (the platform ceiling), with compensating controls**, because the residual risk is acceptable for this specific system:

- The app is internal, has no public value, and holds no financial or personal data beyond names, departments, and meal choices.
- The realistic attack is online guessing, not offline cracking — and online guessing is what the compensating controls address:
  - **Account lockout:** 5 failed attempts → 15-minute lock, recorded on the employee row and audited.
  - **Rate limiting** at the Cloudflare WAF layer on `/api/auth/login`, per IP and per AMCO ID.
  - **Generic failure message** ("Invalid AMCO ID or password") so the endpoint is not an employee-ID oracle.
  - **Admin-issued initial passwords are high-entropy and random**, not `Welcome123` — this removes the largest real risk, which is guessable defaults rather than hash strength.
  - A minimum length of 10 characters on employee-chosen passwords, with a check against a small list of obvious choices. No composition rules — they push people toward `P@ssw0rd1` and weaken outcomes.
- **The algorithm-agility prefix (§4) means this is a reversible decision.** If the company moves to the $5/month Workers Paid plan, raising to Argon2id via WASM is a config change plus transparent rehash-on-login — no password reset, no migration.

I want this decision explicitly acknowledged at review rather than discovered later. It is the one place where the free-tier goal has a genuine security cost.

### 15.3 Transport and headers

- HTTPS everywhere; HSTS via Cloudflare.
- Response headers on every Worker response: `Content-Security-Policy` (no `unsafe-inline` scripts; the SPA needs no inline script), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`.
- **CSRF:** `SameSite=Lax` cookies plus an `Origin` header check on every state-changing request. Both are cheap; either alone would probably do; together they cost nothing and close the gap.
- **CORS:** none. The API is same-origin with the SPA by construction, so no `Access-Control-Allow-Origin` header is ever emitted. An API that cannot be called cross-origin cannot be abused cross-origin.

### 15.4 Input handling

- All SQL through **prepared statements with bound parameters**, without exception. String-concatenated SQL is a review-blocking defect.
- Request bodies validated with **Zod** schemas at the route boundary; the handler receives a typed, validated object and never touches `await c.req.json()` directly.
- Output escaping is React's default; `dangerouslySetInnerHTML` is not used anywhere.

### 15.5 What we log and what we do not

Logged: authentication successes and failures, all admin mutations with before/after, all imports, all overrides.
Never logged: passwords, session tokens, or password hashes — in any form, including error paths and exception messages. Error handlers must be written so a thrown exception cannot carry a credential into a log line.

### 15.6 Optional: Cloudflare Access

If the company already runs Cloudflare Zero Trust, putting `/admin/*` behind an Access policy adds a genuinely independent second factor for the highest-privilege surface at no cost. Recommended as an enhancement, not a dependency — the app's own role model must remain complete and enforced on its own.

---

## 16. Backup and recovery

### Layer 1 — D1 Time Travel (built in)

Point-in-time restore to any moment in the last **7 days** on the free plan (30 on paid), with no configuration. This covers the most likely disaster: a bad import or a mistaken bulk edit noticed within a day or two.

### Layer 2 — nightly logical export to R2 (added, because 7 days is not enough)

The nightly cron writes a compressed logical snapshot of every table to `backups/{YYYY-MM-DD}/canteenhub.json.gz`, with a retention ladder:

- Daily backups: kept 30 days
- Monthly (1st of month): kept 24 months

**Why this exists despite Time Travel:** a meal-attendance record is payroll-adjacent and may be needed for a dispute months later. Seven days of retention cannot answer "what did the roster say in March?" R2's free tier makes 24 months of these snapshots cost nothing, and being outside D1 means a D1-level problem does not take the backups with it.

The cron runs with a 15-minute wall-clock budget rather than the 10 ms HTTP limit, which is what makes a full export feasible on the free plan.

### Layer 3 — the import artifacts

Every original uploaded workbook is already in R2 indefinitely (§11). In the worst case, the operational data can be reconstructed from the source files that produced it.

### Recovery procedures (to be written and, importantly, rehearsed)

| Scenario | Procedure |
|---|---|
| Bad import committed | Time Travel restore to just before the commit timestamp — `import_batches.committed_at` gives the exact target. |
| Single record damaged | Read the value from the latest R2 snapshot; correct it manually through the admin UI, producing a normal audit trail. |
| Database lost entirely | Create a new D1 database, apply migrations, import the latest R2 snapshot. |
| Accidental deletion | Should be structurally impossible — soft deletes and no-delete imports — but Time Travel covers it. |

A restore should be **practised once before go-live**. An untested backup is a belief, not a backup.

---

## 17. Deployment architecture (GitHub → Cloudflare)

### Environments

| Environment | Worker | D1 database | Trigger |
|---|---|---|---|
| **Local** | `wrangler dev` | local SQLite (`--local`) | developer machine |
| **Preview** | version-uploaded preview URL | `canteenhub-preview` (separate DB) | pull request |
| **Production** | `canteenhub` | `canteenhub` | push to `main` |

**Preview uses a physically separate D1 database.** Sharing one would let a preview deployment's migration or test data reach real employee records. The separation is the control; nothing else is trusted to prevent it.

### Pipeline

```
push to main
  → Workers Builds (GitHub integration) picks up the commit
  → npm ci
  → npm run typecheck && npm run lint && npm test
  → npm run build            (Vite → dist/client)
  → wrangler d1 migrations apply canteenhub --remote
  → wrangler deploy
```

Pull requests run the same checks and deploy a preview version against the preview database, so a reviewer gets a working URL.

### Migrations: expand/contract, always

`wrangler d1 migrations apply` runs **before** `wrangler deploy`, which means there is a window — seconds — where the new schema is live under the old code. Therefore **every migration must be backward-compatible with the currently deployed Worker**:

- Add columns as nullable or with defaults; never `NOT NULL` without a default in the same step.
- Never rename or drop a column in the same release that stops using it. Deploy the code that stops reading it, then drop it in a later release.
- Never change a column's type in place.

This discipline is not optional and should be a checklist item on any PR containing a migration. It is the standard cost of not having transactional schema-plus-code deployment, and D1 does not offer one.

### Rollback

`wrangler rollback` reverts the Worker to the previous version in seconds. **Schema rollback is not automatic** — this is precisely why migrations must be additive. A rollback of code against an expanded schema is safe; a rollback against a contracted one is not.

### Branch protection

`main` requires a passing build and one review. This is an internal app with a small team, but the import and eligibility code paths are ones where a solo mistake is expensive and hard to notice.

---

## 18. Environment and configuration strategy

Configuration is deliberately split three ways by *what kind of thing it is*, because conflating them is how secrets end up in git.

### 18.1 Bindings — `wrangler.jsonc`, committed

D1 database IDs, R2 bucket names, cron schedules, compatibility date. These are infrastructure references, not secrets; a D1 database ID is useless without account credentials.

### 18.2 Secrets — `wrangler secret put`, never in git

| Secret | Purpose |
|---|---|
| `SESSION_TOKEN_PEPPER` | Optional extra input to the session-token hash, so a leaked DB alone is insufficient. |
| `PASSWORD_PEPPER` | Optional secret appended to passwords before hashing, held outside the database. |

Deployment credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) live in Workers Builds / GitHub Actions secrets, scoped to the minimum permissions needed (Workers Scripts: Edit, D1: Edit).

A committed `.dev.vars.example` documents the required names with dummy values; `.dev.vars` is gitignored.

### 18.3 Application settings — the `settings` table, admin-editable

Operational values belong in the database, not in environment variables, because **changing the cutoff time should not require a deployment**. The canteen administrator changes it in the UI; it takes effect immediately and is audited.

| Key | Default | Notes |
|---|---|---|
| `lunch_cutoff_time` | `10:00` | Amman local time on the meal date. See Open Question 4. |
| `timezone` | `Asia/Amman` | Jordan is permanently UTC+3, no DST — but resolved via `Intl`, not hardcoded. |
| `working_days` | `[0,1,2,3,4]` | Sun–Thu, for `regular` employees. |
| `upcoming_menu_days` | `7` | How far ahead employees see menus. |
| `lookahead_days` | `14` | Horizon for computing `nextEligibleDate`. |
| `session_ttl_hours` | `12` | `8` for admin sessions. |
| `allow_future_selection` | `true` | See Open Question 2. |
| `import_row_retention_days` | `30` | When staged import rows are purged. |

Every settings change writes an `audit_log` entry with before/after. Settings are read once per request and cached in the isolate for a short TTL — they change rarely and are read constantly.

**Holidays are a table, not a setting**, because they are dated records with descriptions that admins manage individually and that reports need to join against.

**Deliberately not settings:** number of meal options (it is 2, structurally, per §7), which shift values are eligible (Day and Night, per the stated business rule), and whether Amman HQ receives meals (no). Making a hard business rule configurable invites someone to change it by accident and produces a system whose behaviour cannot be reasoned about from its code. The requirements said not to invent unnecessary settings; these are the ones I explicitly declined to add.

---

## 19. Testing strategy

### The priority order, by consequence of failure

**1. Eligibility — exhaustive unit tests (highest value in the project).**
`computeEligibility` is pure, so the full matrix is a table-driven test with no infrastructure: 3 roster types × 7 weekdays × {roster row present/absent} × {day, night, off} × {holiday, not} × {active, inactive}. Every branch, every reason code, plus `nextEligibleDate` for each type. **100% branch coverage is the requirement here, not an aspiration** — a bug in this function means people don't get fed, or the company buys 40 meals nobody eats.

Named cases that must exist explicitly, because they encode the business rules that a future maintainer might "correct":
- Night-shift employee **is** eligible.
- Amman HQ is ineligible on Monday *and* Sunday *and* Friday, always with reason `amman_hq`.
- Regular employee on Friday and Saturday → `regular_weekend`.
- Shift employee with **no roster row** → `roster_missing`, **not** `shift_off`.
- Amman HQ takes precedence over the weekend reason.

**2. Authorization — integration tests that assert refusal.**
Using `@cloudflare/vitest-pool-workers`, which runs tests inside `workerd` against a real local D1 — so these exercise the actual runtime, actual SQL, and actual middleware, not mocks.
- Every `/api/admin/*` route called with an employee session → `403`.
- Every `/api/admin/*` route called with no session → `401`.
- Employee A attempting to read or write employee B's selection through every parameter we expose → `403`/`404`.
- Non-`super_admin` attempting a selection override → `403`.
- These are written as a **loop over the route table**, so a newly added admin route is automatically covered and a missing guard fails the build.

**3. Import safety — the "never destroys data" contract.**
- Committing an employee import that omits existing employees leaves them present and active.
- Re-importing a menu day that has 47 selections leaves all 47 intact and unchanged.
- A roster import that marks a selected day `off` retains the selection and flags it for review.
- A failed chunk rolls back entirely (nothing from that chunk is written).
- A resumed commit produces the same final state as an uninterrupted one.
- Validation rejects: unknown AMCO ID, non-shift employee in a roster file, three menu options, invalid shift value, malformed date.

**4. Selection rules.**
Cutoff enforced server-side; ineligible employee refused; upsert produces one row under concurrent writes; every write produces exactly one history row; override requires a reason.

**5. End-to-end (Playwright, small and targeted).**
- The employee flow: log in → see today → tap Option 1 → confirmed. Asserted **on a mobile viewport**, since that is the actual usage.
- The ineligible employee sees a reason and no selection controls.
- The admin import flow: upload → preview → commit → totals reflect it.
- Not a broad E2E suite — these are slow and brittle. Four or five scenarios that cover the paths where a break would be embarrassing.

**6. Accessibility.** `axe-core` in the E2E run against the employee screens; keyboard-only traversal of the selection flow.

### What we do not test

Framework behaviour, third-party library internals, and getters. Coverage targets are set on the domain logic (`src/shared/domain/**` at 100%) rather than as a project-wide percentage, which would just reward testing trivia.

---

## 20. Risks and limitations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **10 ms CPU on free tier** | High | Architected around: no server parsing, no server export generation, no SSR. Login (PBKDF2) is the tightest path and must be measured before go-live. $5/mo paid plan is the escape hatch and changes nothing else. |
| 2 | **PBKDF2 capped at 100k iterations** | Medium | Accepted with compensating controls (§15.2). Algorithm-agility prefix makes it reversible. Flagged for explicit sign-off. |
| 3 | **50 D1 queries per invocation (free)** | Medium | Chunked, resumable import commit (§11). Normal request paths use fewer than 10 queries. |
| 4 | **100k D1 row writes/day (free)** | Low–Medium | Largest realistic import is ~5k rows. Only a pathological delete-and-reinsert pattern would approach the limit — and we never delete. |
| 5 | **7-day Time Travel retention** | Medium | Nightly R2 snapshots with 24-month retention (§16). |
| 6 | **Migrations are not transactional with deploys** | Medium | Mandatory expand/contract discipline (§17), enforced by PR checklist. |
| 7 | **Timezone / date-boundary errors** | High | Jordan is fixed UTC+3 with no DST, which removes the hardest class of these bugs. Remaining risk handled by a single shared date utility using `Intl` with the configured zone; never `new Date(dateString)`. Explicit tests around midnight and around the cutoff. |
| 8 | **The real workbooks are not available** | Medium | Column mappings are isolated in one module per type (§13) so adapting is a small, contained change. But header names and layout genuinely cannot be finalized until the files are seen — Open Question 1. |
| 9 | **Roster published late** | Medium | Surfaced as first-class `roster_missing` reason and a report line, so it is visible before lunch rather than discovered at lunch. Product problem, not a technical one — but the system must not hide it. |
| 10 | **Single Cloudflare account dependency** | Low | Accepted; it is the stated direction. Mitigated by portability: SQLite schema and standard Web APIs mean the app could be moved to another runtime with moderate effort. Nightly R2 exports mean the *data* is never captive. |
| 11 | **No self-service password reset** | Medium (operational) | Deliberate (§4). Creates an admin workload; needs a documented in-person process. Open Question 5. |
| 12 | **D1 is single-threaded per database** | Low | ~150 users, a handful of queries each. Nowhere near contention. Worth remembering only if the company grows tenfold. |
| 13 | **Client-side parsing means untrusted JSON** | Low | Full server-side re-validation; original file retained in R2 (§13). |
| 14 | **Employees without smartphones** | Unknown | An admin can record a selection on someone's behalf via override — but this needs a policy answer. Open Question 6. |

---

## 21. Recommended project directory structure

```
canteenhub/
├── .github/workflows/ci.yml            # typecheck, lint, test on PR
├── docs/
│   ├── ARCHITECTURE.md                 # this document
│   ├── schema.proposal.sql             # proposed DDL (not a migration)
│   └── runbooks/                       # restore, go-live, import procedures
├── migrations/                         # wrangler d1 migrations — EMPTY until approval
│   └── .gitkeep
├── public/                             # static files copied verbatim
├── src/
│   ├── client/                         # React SPA
│   │   ├── main.tsx
│   │   ├── routes/
│   │   │   ├── employee/               # login, today, menu, me  → core bundle
│   │   │   └── admin/                  # everything admin        → lazy chunk
│   │   ├── components/
│   │   ├── lib/                        # api client, query hooks, date helpers
│   │   └── import/                     # SheetJS parsing + export generation
│   │
│   ├── worker/                         # Cloudflare Worker
│   │   ├── index.ts                    # fetch + scheduled entrypoints
│   │   ├── routes/
│   │   │   ├── auth.ts
│   │   │   ├── employee/               # selections, menu, me
│   │   │   └── admin/                  # employees, menu, roster, selections,
│   │   │                               #   reports, imports, settings
│   │   ├── middleware/                 # session, requireRole, audit, errors,
│   │   │                               #   security headers, origin check
│   │   ├── services/                   # eligibility, selections, imports,
│   │   │                               #   reports, audit, settings
│   │   ├── db/                         # query modules — the ONLY place SQL lives
│   │   └── lib/                        # crypto, dates, responses
│   │
│   └── shared/                         # imported by BOTH client and worker
│       ├── domain/
│       │   ├── eligibility.ts          # ★ the pure function (§12)
│       │   ├── cutoff.ts
│       │   └── dates.ts                # Amman-aware date utilities
│       ├── schemas/                    # Zod — validation AND inferred types
│       ├── import/mappings/            # employee/roster/menu column mappings
│       └── types/
│
├── tests/
│   ├── unit/                           # eligibility matrix, dates, cutoff
│   ├── integration/                    # workerd + local D1: routes, authz, imports
│   └── e2e/                            # Playwright
│
├── wrangler.jsonc
├── vite.config.ts
├── vitest.config.ts
└── package.json
```

### Why `src/shared/domain/` exists and matters

The eligibility rules and cutoff logic are imported by **both** the Worker and the browser. The browser uses them to render the right screen instantly; the Worker uses them to enforce. One implementation, two consumers, zero drift — the UI can never show a selection button the server will reject, and it can never hide one the server would allow.

The shared code is **advisory in the browser and authoritative in the Worker**. The client running the same function is a UX optimisation, never a security control.

### Why `src/worker/db/` is the only place SQL lives

Route handlers call named query functions; they never write SQL inline. This makes prepared-statement discipline auditable in one directory, keeps `employee_id`-scoping visible in a single place, and makes index-vs-query review possible.

---

## 22. Recommended implementation phases

Sequenced so that something useful and correct exists early, and so the riskiest logic is built and proven before anything depends on it.

### Phase 0 — Discovery and architecture ← *this document*
Deliverable: this proposal. **Exit criterion: written approval, plus answers to the Open Questions below.** No code.

### Phase 1 — Foundations
Repo scaffolding, Vite + Worker + Hono skeleton, `wrangler.jsonc`, D1 databases created (prod + preview), first migration applying the approved schema, CI pipeline green, Workers Builds connected, a deployed "hello" that proves the whole GitHub → Cloudflare path works end to end.
*Exit: a commit to `main` reaches production automatically.*

### Phase 2 — Identity and access
Employee table, password hashing, login/logout, sessions, role guards, password change, admin password reset, lockout, audit log infrastructure, security headers.
*Exit: authorization integration tests pass — including every negative case.*

### Phase 3 — The domain core
`computeEligibility` and the cutoff logic, with the exhaustive test matrix. Menu, roster, and settings tables with manual admin CRUD. **Manual entry is built before any importer**, deliberately: it forces the data model to be correct and usable on its own, and guarantees the system is operable even if an import ever fails.
*Exit: an administrator can run a full day manually, and the eligibility matrix is at 100% branch coverage.*

### Phase 4 — The employee experience
Today's meal, the three-tap selection, upcoming menus, eligibility messaging with reasons and next eligible date, own-password change. Mobile-first, accessible, fast.
*Exit: an employee completes a selection in under five seconds on a phone; ineligible employees see a clear, correct reason.*

### Phase 5 — Reports
Daily and monthly reports, the five-line summary, drill-downs, department totals, CSV and client-side Excel export, print stylesheet, nightly snapshot cron.
*Exit: the administrator can produce the catering order for tomorrow without touching a spreadsheet.*

### Phase 6 — Imports
Employee, roster, and menu importers with the validate → preview → chunked commit pipeline, impact analysis, R2 file retention, import history. **Built last on purpose**: by this point the data model is proven by real manual use, so the importer targets a known-good target rather than defining it.
*Exit: the September 2026 workbooks import cleanly, and the "never destroys data" test suite passes.*

### Phase 7 — Hardening and go-live
Rate limiting rules, backup/restore rehearsal, load sanity check, accessibility audit, CPU measurement on the login path against the 10 ms limit, admin runbooks, user documentation, pilot with a small group, then rollout.
*Exit: a restore has actually been performed successfully, not just documented.*

---

# Architecture Decision Summary

1. **Single Cloudflare Worker** serving a static React SPA plus a `/api/*` Hono router — because static asset requests are free and uncounted, while every server-rendered byte spends the scarce 10 ms CPU budget.
2. **No SSR framework.** SSR would spend our scarcest resource to buy something an internal app with 150 users does not need.
3. **One SPA, two lazily-split bundles.** Admin code — including the ~400 KB Excel library — is a lazy chunk an employee's phone never downloads.
4. **D1 as the sole datastore.** No KV (eventual consistency makes session revocation unsafe), no Durable Objects (nothing needs coordination), no Queues (not free, and unnecessary given client-side parsing).
5. **R2 for original uploaded workbooks and nightly backups only** — never in a request-serving path.
6. **Dates stored as `YYYY-MM-DD` text in Amman calendar terms**, timestamps as ISO-8601 UTC. Meal dates are calendar concepts, not instants.
7. **Eligibility is one pure function** taking injected data, shared by the Worker, the UI, and the import impact analyser — so the three can never disagree, and the whole rule set is exhaustively unit-testable with no infrastructure.
8. **`roster_type` on the employee is the single eligibility discriminator** — `regular` reads the working-days calendar, `shift` reads roster rows, `amman_hq` is always ineligible. Department never affects eligibility.
9. **A missing roster row is `roster_missing`, never `off`** — a distinct, first-class outcome, so a late roster becomes a visible operational signal instead of a silent under-count.
10. **`lunch_selections` has no foreign key to the menu.** A selection references the *slot* (`option_1`/`option_2`/`no_preference`), which is what makes "a menu re-import cannot destroy selections" true by construction rather than by careful coding.
11. **Menu normalized into `menu_days` + `menu_options` + `menu_components`**, with `option_number` constrained to exactly 1 or 2 — preserving condiment/beverage/dessert detail without a schema change when the component list grows.
12. **Current state plus append-only history** for selections and roster: one row for "what is true now," an immutable log for "what changed, when, by whom."
13. **Nothing operational is ever hard-deleted.** Employees deactivate, menus unpublish, imports never issue a `DELETE`. Absence from a spreadsheet is not an instruction to delete.
14. **Excel is parsed and generated in the browser, never in the Worker** — forced by the 10 ms CPU limit, and better anyway: instant feedback, no extra service, and the original file is still archived in R2 with its SHA-256 as the authoritative artifact.
15. **Every import passes through validate → preview → chunked atomic commit**, with impact analysis naming the employees and selections that would be affected before anything is written.
16. **Import commits are chunked and resumable** because D1 allows only 50 queries per invocation on the free plan; each chunk is an atomic `batch()`, so failure leaves a resumable state, never a corrupt one.
17. **Opaque server-side session tokens, stored hashed, in `HttpOnly` cookies** — not JWTs, because instant revocation is a hard requirement and the database round-trip we would be avoiding costs nothing here.
18. **PBKDF2-SHA-256 at 100,000 iterations** (the platform ceiling), with an algorithm-agility prefix and compensating controls. **This is the one place the free-tier goal has a real security cost, and it needs explicit sign-off.**
19. **Three roles** — `employee`, `admin`, `super_admin` — with post-cutoff override restricted to `super_admin` and always requiring a written reason.
20. **Authorization is enforced in three server-side layers**; employee routes take identity only from the session and never accept a client-supplied employee ID. The UI hides buttons purely as a courtesy.
21. **Reports are SQL aggregates; eligibility is computed in memory using the same shared function.** Catering quantities come from actual selections only — "eligible but not selected" is a follow-up list, never added to a dish count.
22. **Nightly snapshots freeze historical daily totals**, so a later roster correction cannot silently rewrite the report the caterer was paid against.
23. **Backups in two layers:** D1 Time Travel (7 days) plus nightly compressed R2 exports with 30-day/24-month retention — because a meal record may be needed long after seven days.
24. **Operational configuration lives in a `settings` table, not environment variables**, so changing the cutoff time is an audited admin action rather than a deployment. Hard business rules (two options; Day and Night both eligible; Amman HQ never) are deliberately *not* configurable.
25. **GitHub → Workers Builds → migrations → deploy**, with a separate preview D1 database and mandatory expand/contract migration discipline, since schema and code cannot deploy transactionally.
26. **Manual administration is built before importers** (Phase 3 before Phase 6), so the data model is proven by real use and the system is operable even when an import fails.

---

# Open Questions

These are the questions I genuinely could not resolve from the requirements. Everything else has been decided above.

**1. The three workbooks are not in this repository.**
The requirements refer to an uploaded employee workbook, a September 2026 roster, and a September 2026 menu, and state the employee workbook should be treated as the source of truth for the initial data structure. None of the three is present here — the repository was empty. The column mappings in §13 are isolated so adapting is cheap, but exact header text, sheet names, roster sheet layout (I have assumed employees-as-rows with dates-as-columns), and the precise menu component labels cannot be finalized without the files. **Please attach them before Phase 1.**

**2. May employees select for future dates, or only for today?**
Advance selection helps night-shift employees who will not be online tomorrow morning, and the cutoff still governs the final answer — so §7 proposes allowing it, gated by `allow_future_selection`. But if the caterer's process assumes selections only firm up on the day, this should be `false`. *Which matches how the canteen actually works?*

**3. Is Arabic / RTL required?**
Employee names in the workbook may be Arabic, which the system handles regardless (UTF-8 throughout, BOM on CSV exports). The question is whether the **interface** must be Arabic or bilingual. This materially affects Phase 4 scope. The proposal assumes English-only UI with logical CSS properties so RTL stays cheap to add later.

**4. What is the actual cutoff time, and is it one value or per-shift?**
`10:00` is a placeholder. More importantly: **do night-shift employees need a different cutoff?** Someone starting a night shift may not be awake at 10:00 for a meal served during that shift. If a second cutoff is needed, the settings model must carry one per shift value and the cutoff function branches — a small change now, a schema change later. *And: what should happen to eligible employees who simply never select — does the caterer receive a default portion for them, or nothing?* The report distinguishes them (§14.2), but the ordering policy is a business decision.

**5. Who resets forgotten passwords, and how is the requester identified?**
§4 proposes no self-service reset (there is no email or SMS channel, and it would be the most attackable surface in the app). That places the workload on an administrator. *Is that acceptable operationally, and what identity check should the administrator perform before issuing a new password?* If the company has an internal email system we could use, self-service becomes viable and this changes.

**6. How do employees without a smartphone or computer make a selection?**
If any eligible employees lack device access, they either always fall into "eligible but not selected" or need someone to record their choice. An admin override can do it, but overrides are designed as an exception path with a mandatory reason — using them routinely would pollute the audit trail. If this population exists and is non-trivial, a distinct "recorded on behalf of employee" source is a small addition, best made in Phase 4 rather than retrofitted.

**7. Should Amman HQ employees see the menu at all?**
They can log in but cannot select. *Should they see what is being served (informational, and arguably pleasant), or is the menu irrelevant to them and better hidden to avoid confusion?* The proposal shows it read-only with a clear explanatory banner; this is easily flipped.

**8. Retention policy for personal data.**
Selections, history, and audit records are currently kept indefinitely. If the company has a data-retention or privacy policy governing employee records, it should shape a purge or anonymisation routine for departed employees — and that is far cheaper to design now than to retrofit.

---

*End of Phase 0 proposal. No implementation will begin until this is reviewed and approved.*
