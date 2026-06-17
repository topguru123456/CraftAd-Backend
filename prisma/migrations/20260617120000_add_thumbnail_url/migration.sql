-- Add nullable thumbnail_url column to creative_generations.
--
-- Rows generated before this migration have no thumbnail; the FE
-- falls back to image_url in that case (no backfill required —
-- old projects render at original size, new ones render small).
ALTER TABLE "creative_generations"
  ADD COLUMN "thumbnail_url" TEXT;
