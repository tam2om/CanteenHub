# CanteenHub — Production Deployment

Every value written as `REPLACE_WITH_…` or `<angle brackets>` is a placeholder.
**No real credential, account id, database id or token appears in this
repository, and none should ever be committed to it.**

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Cloudflare account | Workers Paid is **not** required; see §12 for free-tier limits |
| Node.js 22+ | `node:sqlite` is used by the test suite |
| Wrangler | `npx wrangler --version` — 3.78 or newer, for `[assets]` support |
| Authenticated CLI | `npx wrangler login` |

Verify the build is sound before touching Cloudflare:

```bash
npm ci
npm test && npm run typecheck && npm run lint && npm run build
```

---

## 2. Create the Cloudflare resources

### D1

```bash
npx wrangler d1 create canteenhub-prod
```

This prints a `database_id`. It is an account-scoped identifier, not a secret,
but it **is** environment-specific.

### R2

R2 holds the original uploaded import workbooks. D1 stores only metadata and the
object key.

```bash
npx wrangler r2 bucket create canteenhub-imports
```

---

## 3. Configure `wrangler.toml`

Replace the two production placeholders:

| Placeholder | Replace with |
|---|---|
| `REPLACE_WITH_PRODUCTION_D1_DATABASE_ID` | the `database_id` from §2 |
| `https://REPLACE_WITH_PRODUCTION_HOSTNAME` | the origin the browser loads the app from |

> **Wrangler does not inherit bindings into named environments.**
> `d1_databases`, `r2_buckets` and `vars` are non-inheritable: each is repeated
> under `[env.production]` deliberately. Deleting one of those repeats does not
> fall back to the top-level value — it leaves the binding **undefined at
> runtime**, and every request fails.
> <https://developers.cloudflare.com/workers/wrangler/environments/>

Because the Worker serves the SPA itself (`[assets]`), `FRONTEND_URL` is the
Worker's own hostname and every request is same-origin. CORS is then effectively
unused, and the `SameSite=Strict` session cookie works as intended.

---

## 4. Secrets

**There are currently no required secrets.** Sessions use opaque random tokens
stored as SHA-256 hashes in D1; there is no signing key to manage.

If a secret is ever introduced, set it with `wrangler secret put NAME --env
production` and never in `wrangler.toml`. Secrets must never be committed,
logged, returned by an API, or bundled into the frontend.

---

## 5. Apply migrations

```bash
npx wrangler d1 migrations apply canteenhub-prod --env production --remote
```

Migrations are ordered by filename and applied once each. Review with:

```bash
npx wrangler d1 migrations list canteenhub-prod --env production --remote
```

---

## 6. Deploy

```bash
npm run worker:deploy:prod     # builds the SPA, then wrangler deploy --env production
```

> `wrangler deploy` **without** `--env production` deploys the *local*
> configuration under the local name. Always use the script.

---

## 7. Create the first administrator

There is no self-service registration and no password-reset flow by design: an
administrator sets employee passwords directly.

The first admin must therefore be seeded by hand, once:

```bash
# 1. Confirm the role ids shipped by migration 0001.
npx wrangler d1 execute canteenhub-prod --env production --remote \
  --command "SELECT id, name FROM roles ORDER BY id;"

# 2. Insert the administrator WITHOUT a password.
npx wrangler d1 execute canteenhub-prod --env production --remote \
  --command "INSERT INTO employees (amco_id, full_name, roster_type, role_id, is_active)
             VALUES ('<ADMIN_AMCO_ID>', '<Full Name>', 'amman_hq', <ADMIN_ROLE_ID>, 1);"
```

**Do not write a password hash by hand.** Set the password through the running
application so it goes through the same PBKDF2 path the login check uses. Until
a password is set the account cannot sign in, which is the intended state.

To bootstrap the very first password, temporarily promote an existing
authenticated admin, or set it via the admin UI from a second admin account. If
neither exists yet, this is the one genuine chicken-and-egg step: seed a second
admin row and use `PUT /api/admin/employees/:id/password` from the first.

---

## 8. Verify

Run the checklist in [`SMOKE-TESTS.md`](./SMOKE-TESTS.md). At minimum confirm
`GET /api/health` returns success and that a deep link such as
`https://<host>/admin/menu` loads the application rather than a JSON 404 — the
latter means `[assets]` is misconfigured.

---

## 9. Rollback

```bash
npx wrangler deployments list --env production
npx wrangler rollback <DEPLOYMENT_ID> --env production
```

**A Worker rollback does not roll back D1.** A deployment that applied a
migration leaves the schema in place. See [`RECOVERY.md`](./RECOVERY.md).

---

## 10. Scheduled maintenance

A nightly cron (`17 3 * * *`) deletes expired sessions and stale login attempts.
Nothing else is ever purged automatically — audit, selection history, roster and
import records are the record.

---

## 11. What the operator must configure manually

- [ ] D1 database created, `database_id` written into `wrangler.toml`
- [ ] R2 bucket created and named in `wrangler.toml`
- [ ] `FRONTEND_URL` set to the real production origin
- [ ] Migrations applied to the production database
- [ ] First administrator seeded and given a password
- [ ] `lunch_cutoff_time`, `timezone` and `working_days` reviewed in Settings
- [ ] Company holidays entered
- [ ] Custom domain / DNS and SSL, if not using `*.workers.dev`

Timezone is an IANA identifier (`Asia/Amman` by default) and must stay one — a
fixed UTC offset would be wrong across any DST change. The lunch cutoff is a
setting, never a constant.

---

## 12. Free-tier limits that shape the design

| Limit | Value | Consequence |
|---|---|---|
| Worker CPU | 10 ms/request | No heavy parsing; the XLSX reader is hand-written for this reason |
| D1 queries | 50 per invocation | Every list is set-based; no per-row queries |
| D1 bound parameters | 100 per statement | Bulk lookups chunk at ~90 |
| Upload size | 10 MB (enforced) | Larger files are refused with 413 |
| XLSX inflate | 64 MB (enforced) | Guards against a compression bomb |

Static assets are served by Cloudflare and do **not** consume Worker CPU.
