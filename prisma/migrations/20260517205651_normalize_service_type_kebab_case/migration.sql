-- Normalize projects.service_type to kebab-case so the column matches the
-- ids the frontend uses everywhere else (`project-types.config.js`,
-- `getProjectFlow`, `useCopywritingVariants`, etc.). Until this point the
-- backend defaulted to a snake_case sentinel `campaign_creative` while
-- the copywriting wizard wrote `copywriting-ads` explicitly — two
-- conventions in the same column made the list-page badge lookups miss
-- and the per-flow detail branching brittle.
--
-- Safe to re-run conceptually (only touches rows whose value is the
-- legacy snake_case literal). Migration is single-statement-per-line
-- so a partial failure is obvious in the migration log.

-- Backfill: legacy default value → kebab-case.
UPDATE "projects"
SET "service_type" = 'campaign-creative'
WHERE "service_type" = 'campaign_creative';

-- New default for any future row that doesn't pass `serviceType` (the
-- FE now always does, but keep the default aligned just in case).
ALTER TABLE "projects" ALTER COLUMN "service_type" SET DEFAULT 'campaign-creative';
