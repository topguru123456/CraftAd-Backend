-- Add `creative_generations` to Supabase's Realtime publication.
--
-- Prisma's schema model doesn't know about Postgres publications, so when
-- the table was created by the previous migration it was NOT added to
-- `supabase_realtime` automatically. Without this, the frontend's
-- subscribeToProject / subscribeToRow channels never fire — variants don't
-- appear as loading cards on dispatch, scores don't show on completion.
--
-- Three states this migration handles gracefully:
--   1. Shadow DB (Prisma's temporary blank Postgres during `migrate dev`):
--      `supabase_realtime` doesn't exist at all → early-return, no-op.
--   2. Real Supabase DB, table not yet in publication: ALTER runs.
--   3. Real Supabase DB, table already in publication (re-apply / DB clone):
--      early-return, no-op.

DO $$
BEGIN
  -- (1) Supabase-managed publication absent — vanilla Postgres / shadow DB.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;

  -- (3) Already a member — idempotent re-apply.
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'creative_generations'
  ) THEN
    RETURN;
  END IF;

  -- (2) Add the table to the publication.
  EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.creative_generations';
END
$$;
