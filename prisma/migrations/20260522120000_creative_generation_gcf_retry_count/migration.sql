-- Track automatic GCF redispatch attempts on Gemini 429 / RESOURCE_EXHAUSTED.
ALTER TABLE "creative_generations"
  ADD COLUMN IF NOT EXISTS "gcf_retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "edit_gcf_retry_count" INTEGER NOT NULL DEFAULT 0;
