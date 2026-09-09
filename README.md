# CanteenHub

**Employee Meal Selection & Canteen Management System**

An internal web application for daily lunch selection and canteen administration,
built to run entirely on Cloudflare (Workers, D1, R2).

---

## Current status: Phase 0 — Discovery & Architecture

**No application code. No database tables. No dependencies installed.**

This repository currently contains only the architecture proposal, which is
awaiting review and approval before any implementation begins.

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The full Phase 0 proposal — 22 sections, an Architecture Decision Summary, and Open Questions. |
| [`docs/schema.proposal.sql`](docs/schema.proposal.sql) | The proposed D1 schema, as a review document. **Not a migration** — it lives in `docs/` so it cannot be applied accidentally. |

---

## What the system does

The company serves two lunch options each day. Employees who are eligible log
in and choose **Option 1**, **Option 2**, or **No Preference**, so the caterer
knows exactly how many portions of each to prepare and the administrator knows
who chose what.

Eligibility is driven by the employee's roster type:

| Roster type | Eligibility rule |
|---|---|
| **Regular** | Sunday–Thursday. Not eligible Friday or Saturday. |
| **Shift** | Follows the daily shift roster: **Day** and **Night** are both eligible; **Off** is not. |
| **Amman HQ** | Never receives a company meal. Can still log in; cannot select. |

Ineligible employees are shown a plain-language reason and, where it can be
determined, the next date on which they can select.

---

## Reading the proposal

If you are reviewing and have limited time, the two sections that carry the most
consequence are:

- **§12 Eligibility calculation** — the roster-type branching that everything else depends on.
- **§11 Import and audit model** — how Excel imports are prevented from destroying existing selections.

The **Architecture Decision Summary** at the end lists all 26 recommended
decisions in one place, followed by the **Open Questions** that need answers
before Phase 1 can start.

---

## Three things needed before implementation starts

1. **The source workbooks.** The employee file, the September 2026 shift roster,
   and the September 2026 menu are referenced in the requirements but are not in
   this repository. Column mappings cannot be finalized without them.
2. **Answers to the Open Questions** at the end of the architecture document —
   in particular the real cutoff time and whether night-shift employees need a
   different one.
3. **Explicit sign-off on the password hashing decision** (§15.2). Cloudflare's
   platform caps PBKDF2 at 100,000 iterations, below current OWASP guidance.
   The proposal accepts this with compensating controls, but it should be an
   acknowledged decision rather than a discovered one.
