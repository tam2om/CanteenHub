# CanteenHub — Release Checklist

An operator's list. Each line is something to **do and confirm**, in order.
Commands and detail live in `DEPLOYMENT.md`, `RECOVERY.md` and `SMOKE-TESTS.md`;
this is the sequence and the go/no-go.

Replace every `<placeholder>` with a real value. Nothing in this repository
contains credentials, and nothing you paste here should be committed.

---

## Pre-deployment

**Configuration**
- [ ] `wrangler.toml` `[env.production]` has `d1_databases` and `vars` —
      Wrangler does **not** inherit these into a named environment
- [ ] `FRONTEND_URL` is the real production origin (it is the CORS allow-list in
      production; an empty value allows nothing)
- [ ] `database_id` is the real id, not `REPLACE_WITH_PRODUCTION_D1_DATABASE_ID`
- [ ] Both `[assets]` blocks name `binding = "ASSETS"` — without it every deep
      link 404s, because the Worker serves `index.html` itself
- [ ] `npx wrangler deploy --env production --dry-run` lists DB, ASSETS,
      ENVIRONMENT and FRONTEND_URL — and **no** object-store binding

**Secrets**
- [ ] No token, key or account id is committed anywhere — `git grep` the branch
- [ ] Cloudflare credentials live in the deploying shell or CI secret store only
- [ ] The built bundle contains no secret (`grep` `dist/assets/*.js`)

**D1**
- [ ] Production database created; id recorded in `wrangler.toml`
- [ ] A pre-deployment export taken and stored **outside** this account:
      `wrangler d1 export <db> --env production --remote --output ./backup-$(date +%F).sql`

**Object storage**
- [ ] Nothing to do. CanteenHub uses no bucket: a workbook is parsed in the
      request that uploads it and is never stored. If `wrangler.toml` mentions
      `r2_buckets` at all, that is a leftover — remove it

**Migrations**
- [ ] `npm run db:migrate:prod` applied
- [ ] `wrangler d1 migrations list <db> --env production --remote` reports none
      outstanding

---

## Deployment

- [ ] `npm run worker:deploy:prod` (builds first, then `--env production`;
      plain `wrangler deploy` ships the LOCAL config)
- [ ] Worker responds: `GET /api/health` → 200
- [ ] Static assets load (CSS and JS, not just the shell)
- [ ] **SPA fallback**: `GET https://<host>/admin/menu` returns HTML, not
      `{"error":"Not Found"}` — check a deep link, not just `/`
- [ ] Cron trigger `17 3 * * *` is listed under the Worker's Settings → Triggers

---

## Post-deployment

Run `SMOKE-TESTS.md` in full. At minimum:

- [ ] **Login** — employee and admin succeed; a wrong password is refused with a
      generic message; six rapid failures lock the account for 15 minutes
- [ ] **Cookie flags** — `HttpOnly; Secure; SameSite=Strict; Path=/`
- [ ] **Reload** — log in, then reload a deep link. You must stay logged in.
      (This broke in Phase 7: `/api/auth/me` answered 401 to a valid cookie.)
- [ ] **Logout** — returns to login, and a protected route then bounces
- [ ] **Employee** — today's menu, Option 1 / Option 2 / No Preference, change a
      selection, history shows the change, profile loads
- [ ] **Admin** — employees list and edit, set a password (old one stops working
      immediately), settings, holidays
- [ ] **Menu** — create, edit, publish, archive; a draft is invisible to
      employees, an archived menu likewise
- [ ] **Roster** — day view, a manual correction takes effect on eligibility
- [ ] **Reports** — the day's counts match what employees actually chose
- [ ] **Imports** — upload → validate → preview → commit for employees and
      roster; a second commit of the same batch is refused. The response carries
      `original_filename`, `file_size_bytes` and `content_sha256` and **no**
      `file_archived` flag: the workbook itself is not kept

---

## Recovery

- [ ] **D1 backup** — a manual export is taken and stored off-account, and you
      have restored one into a throwaway database at least once
- [ ] **Time Travel** — ⚠️ **UNVERIFIED in this repository.** Rehearse
      `wrangler d1 time-travel info` and `restore` on a throwaway database
      **before** you need it, and confirm the retention window your plan gives
- [ ] **Single store** — D1 is the only thing to recover. There is no object
      store to fall out of step with it, and no uploaded workbook to lose,
      because none is kept. Re-running an import means re-uploading the file
- [ ] **Stuck import** — you have read `RECOVERY.md` §4.1 and §4.2 and know the
      difference between "wrote nothing" and "applied but not recorded"
- [ ] **Login lockout** — you know the key is `<IP>:<AMCO ID>`, not the AMCO ID
      alone (`RECOVERY.md` §4.3)

---

## Security

- [ ] Cookies are `HttpOnly; Secure; SameSite=Strict` in the live response
- [ ] An employee account gets 403 on every `/api/admin/*` endpoint
- [ ] No response anywhere contains `password_hash`, a session token, or a hash
- [ ] Setting a password revokes that employee's existing sessions
- [ ] `ENVIRONMENT = "production"` — error responses say `Internal Server Error`
      and nothing more; details go to `wrangler tail`
- [ ] `wrangler tail` shows no password, token, hash or cookie value

---

## Business rules

- [ ] **Timezone** — `timezone` setting is the intended IANA name. It must stay
      an IANA identifier; a fixed `+03` offset breaks the day the policy changes
- [ ] **Working days** — `working_days` matches the real week (default
      `[0,1,2,3,4]`, Sunday–Thursday)
- [ ] **Cutoff** — `lunch_cutoff_time` reviewed. It is a setting, not a
      constant; confirm a selection is refused after it in the live system
- [ ] **Eligibility** — spot-check one employee of each kind: regular on a
      working day and a weekend, shift Day / Night / Off, one with no roster
      entry (must read ROSTER_MISSING, never "Off"), and one Amman HQ
- [ ] **Holidays** — this year's company holidays entered; an otherwise eligible
      employee is refused on one
- [ ] **Menu publishing** — nothing is auto-published. Imports and edits leave a
      day as `draft`; publishing is a separate, deliberate action
- [ ] **Reporting** — the caterer-facing numbers are read the right way:
      `eligible_not_selected` is people who may eat but did not choose, and
      `ineligible_with_selection` is a selection left behind by a later roster
      or menu change, not a double count

---

## Final go / no-go

Ship only when every line above is checked **and**:

- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all clean
      on the exact commit being deployed
- [ ] The smoke tests were run **against the deployed URL**, not against a local
      `wrangler dev`
- [ ] A named person owns the first week of operation and can reach
      `RECOVERY.md`
- [ ] You accept the two items this repository has **never** been able to
      verify: a real Cloudflare deployment, and a D1 Time Travel restore. Both
      are documented, neither is tested. Rehearse the restore on a throwaway
      database before you rely on it.

**No-go if any of these is true:** a deep link returns JSON 404 · the session
does not survive a reload · an employee reaches an admin endpoint · a response
carries a password hash · migrations are outstanding · no off-account backup
exists.
