# CanteenHub — Backup, Recovery and Import-State Procedures

**Nothing in this document has been exercised against a real Cloudflare
account.** The Cloudflare capabilities described are as documented by
Cloudflare; the application-side behaviour is what the test suite verifies. An
operator should rehearse §1 and §2 on a throwaway database **before** relying on
them.

---

## 1. What is backed up, and what is not

| Store | Backup mechanism | Verified here? |
|---|---|---|
| **D1** | Cloudflare **Time Travel** — point-in-time restore within the retention window of the account's plan | ❌ documented only |
| **R2** (import archive) | **None by default.** Objects persist until deleted; there is no snapshot | ❌ |
| **Worker code** | Git, plus Cloudflare deployment history | ✅ |
| **Configuration** | `wrangler.toml` in Git; placeholders only | ✅ |

There is **no application-level backup system**, and this phase deliberately did
not build one. Time Travel is the mechanism; the operator must confirm the
retention window their plan actually provides rather than assuming one.

### Taking a manual export

```bash
npx wrangler d1 export canteenhub-prod --env production --remote --output ./backup-$(date +%F).sql
```

Store it outside the account it came from. This is the only backup that survives
the account itself.

**Restoring from that export** — into a freshly created, empty database:

```bash
npx wrangler d1 execute <database-name> --env production --remote --file ./backup-YYYY-MM-DD.sql
```

The export carries the `d1_migrations` ledger with it, so after the restore
`wrangler d1 migrations list` reports nothing to apply. Do **not** run
`migrations apply` first: the export contains the same `CREATE TABLE`
statements and they will collide.

### Rehearsal status

Rehearsed end to end on a throwaway database (destroy the store, restore from
the export, confirm the application serves the restored data):

| Procedure | Rehearsed? |
|---|---|
| Manual export → total loss → restore → application reads the restored data | ✅ |
| §4.1 releasing a stuck batch, including the compare-and-swap no-op on re-run | ✅ |
| §4.2 marking an applied-but-uncommitted batch committed, and the API's refusal to double-commit | ✅ |
| §2 Time Travel `info` / `restore` | ❌ — needs a real Cloudflare account; never rehearsed |

Time Travel therefore remains an **unverified** mechanism in this repository.
Rehearse it on a throwaway database before relying on it.

---

## 2. Restoring D1

```bash
npx wrangler d1 time-travel info canteenhub-prod --env production
npx wrangler d1 time-travel restore canteenhub-prod --env production --timestamp <ISO_TIMESTAMP>
```

### The consequence nobody expects: D1 and R2 restore independently

R2 is **not** rolled back with D1. Restoring D1 to a point before an import was
committed leaves the workbook still in R2, and the `import_batches` row that
referenced it gone. The object is then orphaned — harmless, but it will never be
cleaned up automatically.

The reverse is worse: if an R2 object is deleted while D1 still references it,
`file_archived` reports `true` and the download fails at read time. The
application handles this as an error rather than a crash, but the source
workbook is gone.

**Practical rule:** treat R2 as append-only. Do not delete import objects as
routine housekeeping.

---

## 3. Migration recovery

Migrations are ordered by filename and applied once each. D1 has **no `down`
migrations** and none are written here.

- **A migration failed part-way.** D1 applies each migration file in a
  transaction; a failure leaves that file unapplied. Fix the SQL, redeploy,
  reapply. Never edit a migration that has already been applied in production —
  add a new one.
- **The schema drifted from the code.** Compare against a fresh database:
  `npx wrangler d1 migrations list canteenhub-prod --env production --remote`.
  The test suite applies the entire chain from empty on every run, so a drift is
  an operational fact, not a code defect.
- **A migration must be undone.** Write a new forward migration. Restoring via
  Time Travel also reverts the schema, at the cost of every write since.

---

## 4. Import state recovery

The import state machine:

```
pending → validating → validation_failed
                    ↘ preview → committing → committed
                                          ↘ commit_failed
```

Transitions are compare-and-swap (`UPDATE … WHERE status = ?`), so two
administrators racing the same commit produce exactly one winner; the loser gets
409.

### What happens when the Worker dies mid-flight

| Failure | Resulting state | Business data | Operator action |
|---|---|---|---|
| Dies during **validation** | stuck `validating` | none written — validation never writes | Re-upload. See §4.1 to release the stuck row |
| Dies during **commit, before the batch** | stuck `committing` | none written | §4.1 |
| **R2 put fails** on upload | `validation_failed`, `file_archived = false` | none | Re-upload; nothing to clean up |
| **D1 batch fails** mid-commit | `commit_failed` | **none** — the batch is transactional, all or nothing | Fix the workbook, re-upload |
| **Batch succeeds, status transition fails** | stuck `committing` | **applied** | §4.2 — the one genuinely partial state |

### 4.1 Releasing a stuck batch that wrote nothing

Confirm first that the business tables are untouched, then:

```bash
npx wrangler d1 execute canteenhub-prod --env production --remote \
  --command "SELECT id, import_type, status, created_at FROM import_batches
             WHERE status IN ('validating','committing')
               AND created_at < datetime('now','-1 hour');"

npx wrangler d1 execute canteenhub-prod --env production --remote \
  --command "UPDATE import_batches
             SET status = 'commit_failed',
                 failure_reason = 'Released manually: worker terminated mid-flight'
             WHERE id = <BATCH_ID> AND status = 'committing';"
```

The `AND status = …` clause is not decoration — it is the same compare-and-swap
the application uses, and it stops the update if the batch has meanwhile
finished.

### 4.2 The known D1 limitation — batch applied, status not recorded

D1 offers no transaction spanning a `batch()` and the statements after it.
Between the business write and the status update there is a window in which the
Worker can die with the data applied and the batch still `committing`.

**This is not corruption and not a double-apply.** `commitImport` refuses any
batch not in `preview`, so the stuck batch can never be committed again. Every
importer is also idempotent by construction: employees and roster upsert on a
natural key, menu options upsert on `(menu_day_id, option_number)`.

Recovery: verify the data landed, then mark the batch `committed`:

```bash
npx wrangler d1 execute canteenhub-prod --env production --remote \
  --command "UPDATE import_batches
             SET status = 'committed', committed_at = datetime('now')
             WHERE id = <BATCH_ID> AND status = 'committing';"
```

If the data did **not** land, use §4.1 instead and re-import. Because every
importer is idempotent, re-importing an already-applied workbook is safe: it
classifies every row UNCHANGED and writes nothing.

**Deliberately not built:** a distributed transaction system, a two-phase
commit, or a reconciliation daemon. The window is small, the failure is
detectable by a single query, and the recovery is two commands.

---

## 5. What cannot be recovered

- **A deleted R2 object.** The source workbook is gone; the import's staged rows
  and audit record remain.
- **Writes made after the Time Travel timestamp** you restore to.
- **Anything at all if the Cloudflare account is lost.** The `d1 export` in §1 is
  the only defence, and only if it is stored elsewhere.

---

## 6. Routine operational checks

| Check | Command / place | Cadence |
|---|---|---|
| Stuck imports | the `SELECT` in §4.1 | weekly |
| D1 size | `npx wrangler d1 info canteenhub-prod --env production` | monthly |
| Manual export | §1 | before every deployment that migrates |
| Audit growth | `SELECT COUNT(*) FROM audit_log;` | quarterly |

`audit_log`, `lunch_selection_history`, `roster_entries` and `import_batch_rows`
grow without bound **by design** — they are the record. No retention policy is
enforced because none has been stated. If one is ever set, it belongs in a
migration and a documented decision, not in the nightly cron.
