-- ============================================================================
-- 20260521120000_add_edit_clean_image_url
--
-- Adds `edit_clean_image_url` to `creative_generations`. Pairs with the
-- existing `edit_image_url` the way `clean_image_url` pairs with `image_url`:
-- the watermarked preview lives in the public `creatives` bucket, the
-- unwatermarked path lives in the private `creatives-clean` bucket and is
-- only resolvable via the /downloads endpoint after a quota / ownership
-- check.
--
-- Nullable + no default so legacy rows (where no edit has been started)
-- stay null. The commit-edit service falls back to `edit_image_url` for
-- rows that pre-date this column.
-- ============================================================================

ALTER TABLE "creative_generations"
  ADD COLUMN "edit_clean_image_url" text;
