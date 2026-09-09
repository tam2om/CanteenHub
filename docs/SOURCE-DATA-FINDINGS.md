# Source Data Findings

**Verified against the actual files, 2026-09-09.** This document replaces the
assumptions made in `ARCHITECTURE.md` §13 before the files were available.

Files examined:

| File | Type | Contents |
|---|---|---|
| `New Microsoft Excel Worksheet (Copy).xlsx` | XLSX, 2 sheets | `Shifts roster` + `All Employees` |
| `Food_Menu_Lunch_Sep2026.pdf` | PDF (1 page) | 30-day lunch menu, 1–30 Sep 2026 |
| `Food_Menu_Dinner_Sep2026.pdf` | PDF (1 page) | 30-day dinner menu, 1–30 Sep 2026 |

**Headline:** the employee data matched the architecture's assumptions exactly.
The roster layout is different from what was assumed. The menus are not Excel
files at all, and there is a **dinner service the requirements never mentioned**.

---

## 1. Employees — `All Employees` sheet

Header row 1, data from row 2. Range `A1:E15` (14 employees in this sample).

| Column | Header | Sample values |
|---|---|---|
| A | `AMCO ID#` | `AMCO002`, `AMCO004`, `AMCO024` |
| B | `Name` | `Muwafaq Ibrahim M. Al Zoubi` |
| C | `Department` | `Mining`, `Technical Services`, `HSE`, `Finance`, `Facility & Site Support` |
| D | `Section` | `Management`, `Mining Operations`, `Geology`, `Planning`, `HSE`, `Common Management`, `Site Services`, `Finance`, `Maintenance`, `Fleet &Transportation` |
| E | `Roster` | `Regular`, `Shift`, `Amman HQ` |

**This is exactly what the architecture assumed.** No changes needed to the
employee model (`ARCHITECTURE.md` §8).

Confirmed facts:

- **AMCO ID format is `AMCO` + 3 digits**, zero-padded. Sequential with gaps
  (002, 004, 008, 010, 012–016, 019, 021–024) — so IDs are assigned, not dense.
  The importer should treat it as an opaque string, **not** parse the numeric
  part or assume a fixed length.
- **The `Roster` column carries exactly the three expected values**, in Title
  Case with a space in `Amman HQ`. Mapping to the internal enum:
  `Regular` → `regular`, `Shift` → `shift`, `Amman HQ` → `amman_hq`.
- **`Amman HQ` is confirmed to be a roster type, not a department.** AMCO013 is
  in department `Facility & Site Support`, section `Common Management`, roster
  `Amman HQ`. AMCO014 is in the *same department* with roster `Regular`.
  Deriving eligibility from department would have given both employees the same
  answer, and it would have been wrong for one of them. `ARCHITECTURE.md` §8
  called this out as a risk; the sample data confirms it is a real one.
- Department and Section are free text and **contain stray whitespace**:
  `"Maintenance  "` (trailing), `" Fleet &Transportation  "` (leading and
  trailing, and a missing space in `&Transportation`). The importer must
  `trim()` and collapse internal runs of whitespace on every text field, or
  `GROUP BY department` in reports will produce duplicate rows that look
  identical on screen.

---

## 2. Shift roster — `Shifts roster` sheet

**This differs from the assumed layout, and the difference matters.**

```
        A    |   B   |  C   |  D  |  E  |  F  | ... | AH
     -------------------------------------------------------
  1    code  | month | year |  1  |  2  |  3  | ... | 31
  2  AMCO093 |   9   | 2026 | Off | Off | Day | ... |
  3  AMCO094 |   9   | 2026 | Off | Off | Off | ... |
  4  AMCO243 |   9   | 2026 | Off | Off | Off | ... |
```

### What the architecture assumed vs. what is true

| Assumed (§13) | Actual |
|---|---|
| A separate roster workbook | **Same workbook as employees**, second sheet |
| Employee key column `AMCO ID#` | Column is named **`code`** |
| Date columns as full dates | **Day-of-month numbers `1`–`31`**, with `month` and `year` as their own data columns |

### Consequences for the importer

1. **It must handle a multi-sheet workbook** and route sheets by name, rather
   than expecting one file per entity. `ARCHITECTURE.md` §13 described three
   separate uploads; the real employee/roster file is a single upload that
   yields two import batches, or one batch spanning two entity types. The
   simpler and safer choice is: **the admin picks which sheet to import**,
   with the sheet name pre-selected by a best guess. Auto-importing both
   sheets from one file would mean a single confirmation click committing two
   different kinds of change, which defeats the purpose of the preview stage.

2. **The employee key header differs between sheets** — `AMCO ID#` on one,
   `code` on the other, for the same business key. The alias list in the column
   mapping must cover both, and this is exactly why matching by header text
   with an explicit alias set (not by column position) was the right call.

3. **The date is composed from three columns**, not read from a header:
   `date = (row.year, row.month, dayColumnIndex)`. This is genuinely better
   than the assumed layout — one file can carry several months as separate
   rows, and the importer needs no date parsing at all, just integer
   composition. It also means **the same employee can legitimately appear on
   multiple rows** (one per month), so the uniqueness key for a roster row is
   `(code, year, month)` at the sheet level and `(employee_id, work_date)` at
   the database level, exactly as modelled.

4. **There are always 31 day columns, regardless of month length.** September
   has 30 days, and column `31` is blank in all three rows. The importer must:
   - ignore day columns beyond the real length of `(year, month)`;
   - treat a **populated** day-31 cell in a 30-day month as a **validation
     error**, not silently drop it — a value there means the file is wrong, or
     the month/year columns are wrong, and either way somebody should look.

5. **Shift values are Title Case:** `Day`, `Night`, `Off`. Mapping is
   case-insensitive and whitespace-trimmed. A blank cell within a valid day
   range is **no entry** — reported as such, never coerced to `Off`
   (`ARCHITECTURE.md` §9).

### The referential finding

**None of the three employees in the roster sheet exist in the employee sheet.**
The roster references `AMCO093`, `AMCO094`, `AMCO243`; the employee sheet
contains `AMCO002` through `AMCO024`.

Both sheets are clearly partial samples, so this is not a data defect to report.
But it demonstrates the rule in `ARCHITECTURE.md` §13 is load-bearing rather
than theoretical: **a roster import must reject unknown AMCO IDs as errors and
must never auto-create employees.** Had the importer been permissive, this file
would have silently created three employees with no name, no department, and no
roster type — and a missing `roster_type` is the one field the entire
eligibility calculation depends on.

### The observed rotation pattern

Useful for building test fixtures:

| Employee | Pattern |
|---|---|
| `AMCO093` | 4 off / 4 day, offset A |
| `AMCO094` | 4 off / 4 day, offset B |
| `AMCO243` | 4 off / 2 day / 2 night, repeating |

`AMCO243` confirms that a single employee genuinely alternates Day and Night
within one month — so **`shift_value` must be per-day, never an attribute of
the employee.** The model already does this; it is now confirmed rather than
assumed.

---

## 3. Menus — **not Excel, and there are two of them**

### 3.1 They are PDFs

`ARCHITECTURE.md` §13 assumed the menu arrives as a workbook. It does not — both
menus are single-page PDFs.

However, both files carry `/Producer = Microsoft® Excel® for Microsoft 365`.
**The source of truth is a spreadsheet; we were given its print export.**

**Recommendation: request the source `.xlsx` and import that. Do not build a PDF
table extractor.**

This is not a preference. Extracting these tables requires reconstructing rows
and columns from absolute text coordinates, and a cell whose text wraps starts
at a different x-position than the column it belongs to. Extracting the lunch
menu for this analysis mis-assigned **4 of the 30 rows** — 13% — purely from
text wrapping, and every one of those errors put a main dish in the wrong
column. In a system whose entire purpose is telling a caterer how many portions
of which dish to prepare, a 13% row-level error rate in the menu importer is
not a tuning problem, it is a disqualifying one.

If the source workbook genuinely cannot be produced, the fallback is **manual
entry**, which the architecture already requires (`ARCHITECTURE.md` §22, Phase 3
builds manual CRUD before any importer). 30 days × 2 services is roughly an
hour of typing per month against a purpose-built form, and it is correct.
A PDF importer would be faster and wrong.

### 3.2 Lunch menu structure

```
Day | Date | Option 1 | Option 2 | Option Meal 1 | Option Meal 2 | Condiment | Beverage | Dessert / Fruits
```

Sample rows (1–7 September 2026):

| Date | Option 1 | Option 2 | Option Meal 1 | Option Meal 2 | Condiment | Beverage | Dessert |
|---|---|---|---|---|---|---|---|
| Tue 1-Sep-26 | Sayyadia with Fish | Chili chicken with rice | Tahina Salad / Lemon | Youghurt | Pickles | Cola or Juice or Water | Seasonal fruit |
| Wed 2-Sep-26 | lamb Mansaf | Freekeh with chicken | Rocca & Onions | Youghurt | Pickles | Cola or Juice or Water | Warbat |
| Thu 3-Sep-26 | Maqluba with Checken | Kofta with tahini & Vermicelli rice | Arabic Salad | Youghurt | Pickles | Cola or Juice or Water | Seasonal fruit |
| Fri 4-Sep-26 | Chicken Tikka with Potato Rosto / Lentil Soup | Fettuccine Pasta | Garlic Souce | Youghurt | Pickles | Cola or Juice or Water | Arabic Sweet |
| Sat 5-Sep-26 | Chicken bukary | Okra with meat and rice | Dagoos | Youghurt | Pickles | Cola or Juice or Water | Seasonal fruit |
| Sun 6-Sep-26 | Ozi with chicken | Molokhia with rice and chicken | Arabic salad/Lemon | Yoghurt | Dagoos | Cola or Juice or Water | Arabic Sweet |
| Mon 7-Sep-26 | Chicken Makpos | Chicken escalope F.F / Day's soup | Arabic Salad | Yoghurt | Dagoos | Cola or Juice or Water | Seasonal fruit |

#### The trap: "Option Meal 1" and "Option Meal 2" are NOT employee choices

The header names are genuinely misleading. Reading the header row alone, a
developer would reasonably build **four** selectable options. The data says
otherwise:

- `Option Meal 1` is always a **salad** — Tahina Salad, Rocca & Onions, Arabic
  Salad, Dagoos, Coleslaw/Garlic Souse, Green Salad.
- `Option Meal 2` is almost always **`Youghurt` / `Yoghurt`** — a dairy side.

These are accompaniments served with whichever main the employee picked. This
matches the requirement's statement that there are two lunch options plus common
components, and that common components are informational. **The employee choice
remains Option 1 vs Option 2 vs No Preference — nothing else.**

The importer must map these two columns to *components*, not options, and the
mapping module should carry a comment saying why, because the header text
actively argues for the wrong reading.

#### Component types

The real file has **five** component columns, not the three named in the
requirements (condiment, beverage, dessert/fruit):

| Column | Internal `component_type` |
|---|---|
| `Option Meal 1` | `salad` |
| `Option Meal 2` | `side` |
| `Condiment` | `condiment` |
| `Beverage` | `beverage` |
| `Dessert / Fruits` | `dessert` |

`schema.proposal.sql` has been updated accordingly. The normalized
`menu_components` table absorbs this without a structural change — which is
precisely the argument §7 made for not using a wide table with one column per
component. Had the wide model been chosen, this discovery would already be a
schema migration.

#### The menu covers all seven days

There are menu rows for **Friday 4-Sep and Saturday 5-Sep**, and for every other
weekend day in the month. This is consistent and expected: Regular employees are
not eligible on Fri/Sat, but Shift employees on a Day or Night rotation are, and
they still need feeding.

This confirms the model is right: **`menu_days` is per calendar day and is
entirely decoupled from eligibility.** A menu existing for a date says nothing
about who may select it. No change needed.

#### Data quality

Preserved verbatim; the importer must not "helpfully" normalize dish names.

- Inconsistent spelling of the same item: `Youghurt` (days 1–5, 16–18) vs
  `Yoghurt` (days 6+). Both are the same product.
- Typos throughout: `Checken`, `Souce` / `Souse`, `Sweat&Sawar Chiken`, `Makpos`
  vs `Chicken Makpos`, `Cucmber` (dinner).
- Inconsistent separators between a main and its soup/side: ` / `, `//`, `/`.
- Leading and doubled internal spaces: `" Okra with meat and rice"`,
  `"Chicken  Tikka"`, `"Tahina  Salad"`.

**Recommendation: store the text exactly as given** (after trimming leading and
trailing whitespace only). These strings are read by humans deciding what to
eat, and a canteen administrator can correct them through the manual edit
screen. Fuzzy-matching or auto-correcting dish names would be an importer
inventing data, which is the one thing an importer must never do.

Dates are formatted `d-MMM-yy` (`1-Sep-26`). If a source workbook is supplied,
these will be real Excel date serials and the ambiguity disappears — another
reason to prefer it.

### 3.3 Dinner menu — a service the requirements never mentioned

**This is the most significant finding in the file set.**

```
Date | Day | Main Item | Optional Alternative | <accompaniment> | <drinks>
```

| Date | Main Item | Optional Alternative | Accompaniment | Drinks |
|---|---|---|---|---|
| Tue 1-Sep-26 | Chicken escalope F.F | Labaneh & Sanyoora & Yellow or Vita Cheese | Tomato & Cucmber & Pickles / arabic bread | Drinks or Tea or coffee |
| Wed 2-Sep-26 | Mutabel / Omelette / Yellow cheese | Tuna or Sardeen with Lemon/vegetable | Tomato & Cucmber & Pickles / arabic bread | Drinks or Tea or coffee |
| Thu 3-Sep-26 | Chicken liver / Hummus / Potato Rosto | Tuna or Sardeen with Lemon/vegetable | Tomato & Cucmber & Pickles / arabic bread | Drinks or Tea or coffee |
| Fri 4-Sep-26 | Akkawi cheese sandwich / Potato Rosto | Labaneh & Sanyoora & Yellow or Vita Cheese | Tomato & Cucmber & Pickles / arabic bread | Drinks or Tea or coffee |

Also 30 rows, 1–30 September 2026, all seven weekdays.

**Structurally it is the same shape as lunch** — a two-way choice plus common
components — but with different column names and only two component columns
instead of five:

| | Lunch | Dinner |
|---|---|---|
| Choice A | `Option 1` | `Main Item` |
| Choice B | `Option 2` | `Optional Alternative` |
| Components | 5 (salad, side, condiment, beverage, dessert) | 2 (accompaniment, drinks) |

The requirements describe a **lunch-only** system: "For lunch, the company
provides two meal options each day." Dinner is never mentioned. Yet a dinner
menu exists, is published monthly alongside lunch, and the workforce includes
Night-shift employees who are explicitly stated to be meal-eligible.

The obvious hypothesis — **Day shift eats lunch, Night shift eats dinner** —
is plausible and would change the eligibility model materially. But it is a
hypothesis, and the architecture must not invent business rules. See the
recommendation below and Open Question 8 in `ARCHITECTURE.md`.

---

## 4. What changes in the architecture

### 4.1 Add the `meal_type` dimension now, ship lunch only

**Recommendation: add `meal_type ∈ ('lunch','dinner')` to the menu and selection
models immediately, default every row to `'lunch'`, and build only the lunch
feature in Phase 4.**

The reasoning is asymmetric cost, not speculation:

- **Adding it now** costs one column on two tables, one `CHECK`, and its
  inclusion in two unique keys. Perhaps an hour.
- **Adding it later** means migrating every historical selection row, every
  report query, every snapshot, and the unique constraint that guarantees one
  selection per employee per day — while the system is live and holding real
  meal history. `UNIQUE(employee_id, meal_date)` becoming
  `UNIQUE(employee_id, meal_date, meal_type)` is not a hard migration in
  isolation, but doing it under an expand/contract discipline
  (`ARCHITECTURE.md` §17) against live data is several days of careful work.

The evidence that dinner is real is sitting in the file set. Modelling the
dimension while deliberately not building the feature costs almost nothing and
removes the expensive version of this decision entirely. If the answer to Open
Question 9 turns out to be "dinner is out of scope permanently," we will have
carried one unused column — a trivial price for the option.

The naming follows: `menu_days` → keyed by `(meal_date, meal_type)`, and
`lunch_selections` → **`meal_selections`**, since a table named for lunch that
may hold dinner rows is a name that will mislead someone within a year.

### 4.2 Confirmed with no change required

- Employee model (§8) — the sheet matches exactly.
- `roster_type` as the sole eligibility discriminator (§12) — and the AMCO013 /
  AMCO014 pair proves department must not be used.
- Per-day `shift_value` (§9) — AMCO243 alternates Day and Night within a month.
- `menu_days` decoupled from eligibility (§7) — weekend menus exist.
- Normalized `menu_components` (§7) — absorbed 5 component types where the
  requirements named 3, with no schema change.
- No-auto-create on import (§13) — the roster sheet references employees absent
  from the employee sheet.

### 4.3 Revised in `ARCHITECTURE.md` §13

- Employee and roster arrive in **one multi-sheet workbook**; the admin selects
  which sheet to import, one entity per confirmation.
- Employee key aliases must include both `AMCO ID#` and `code`.
- Roster dates compose from `year` + `month` + day-column index; day columns
  beyond the month's length are ignored, but a populated one is an error.
- All text fields are trimmed and internal whitespace runs collapsed.
- The menu importer targets a **source `.xlsx`, not the PDF**.
