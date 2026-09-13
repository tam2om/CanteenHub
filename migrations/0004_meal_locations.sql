-- ============================================================================
-- Migration 0004 - where the meal is collected
-- ============================================================================
--
-- CanteenHub serves three canteens. Until now the system recorded WHAT an
-- employee eats but not WHERE they collect it, so the kitchen could not be told
-- how many portions to send to each site - which is the number it actually
-- needs.
--
-- TWO columns, deliberately, because they answer two different questions:
--
--   employees.default_location   where this person normally eats. Set by an
--                                administrator or by the employee import, and
--                                used to pre-fill their daily choice.
--   lunch_selections.pickup_location   where THIS meal on THIS date is to be
--                                collected. Defaults to the employee's default
--                                and may be changed for a single day.
--
-- Storing the location on the SELECTION rather than reading the employee's
-- default at report time is the point: a report run next month must say where
-- the meal was actually collected, not where that employee happens to eat now.
--
-- Backfill: every existing selection takes the owning employee's default, which
-- is itself seeded to 'amco_canteen'. No row is left without a location, so the
-- NOT NULL constraints below hold from the moment they are added.

-- --- employees ---------------------------------------------------------------
ALTER TABLE employees ADD COLUMN default_location TEXT NOT NULL
  DEFAULT 'amco_canteen'
  CHECK (default_location IN ('amco_canteen', 'omco_canteen', 'whc_canteen'));

-- --- lunch_selections --------------------------------------------------------
-- Added nullable first so the backfill below can populate it, then enforced by
-- the CHECK. SQLite cannot add a NOT NULL column without a constant default, and
-- a constant default would be wrong here: the value must come from the employee.
ALTER TABLE lunch_selections ADD COLUMN pickup_location TEXT
  CHECK (pickup_location IN ('amco_canteen', 'omco_canteen', 'whc_canteen'));

UPDATE lunch_selections
   SET pickup_location = (
     SELECT e.default_location FROM employees e WHERE e.id = lunch_selections.employee_id
   )
 WHERE pickup_location IS NULL;

-- Any selection whose employee row has since been removed falls back rather
-- than being left null. There should be none - the foreign key cascades - but a
-- report must never meet a location it cannot name.
UPDATE lunch_selections SET pickup_location = 'amco_canteen' WHERE pickup_location IS NULL;

-- --- history -----------------------------------------------------------------
-- The history table records what changed; a location change is a change worth
-- recording, so it carries the same pair of columns the choice already has.
ALTER TABLE lunch_selection_history ADD COLUMN previous_location TEXT
  CHECK (previous_location IN ('amco_canteen', 'omco_canteen', 'whc_canteen'));
ALTER TABLE lunch_selection_history ADD COLUMN new_location TEXT
  CHECK (new_location IN ('amco_canteen', 'omco_canteen', 'whc_canteen'));

-- --- indexes -----------------------------------------------------------------
-- The daily report groups by (meal_date, pickup_location); the existing
-- idx_lunch_selections_meal_date alone would make that a scan per location.
CREATE INDEX IF NOT EXISTS idx_lunch_selections_date_location
  ON lunch_selections(meal_date, pickup_location);
