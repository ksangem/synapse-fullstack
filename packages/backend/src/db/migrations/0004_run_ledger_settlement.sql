-- Run ledger: the three counts, and the index the settlement query reads.
--
-- `runs` carried two counters that meant one thing between them. They now split three
-- ways so a run row can be read without guessing:
--   records_read — rows the SOURCE produced.
--   records_in   — deliveries the run should produce (published × live targets); the
--                  denominator getRunStatus/settleRun count settled out-messages against.
--   records_out  — deliveries that actually SUCCEEDED, written by settleRun as they land.
-- records_read is added here because the running database got it by hand; without this
-- file a fresh database would come up one column short of the code.
--
-- IF NOT EXISTS: safe on both a fresh database and the ones already carrying the column.
ALTER TABLE "app"."runs" ADD COLUMN IF NOT EXISTS "records_read" integer DEFAULT 0;--> statement-breakpoint

-- Every out-message settles the run by tallying its siblings, and the Wizard polls the
-- same tally a few times a second while a push runs — both filtered by exactly this pair.
-- Unindexed, each one was a sequential scan of the whole ledger (already ~2.7k rows and
-- growing with every record ever delivered).
CREATE INDEX IF NOT EXISTS "idx_run_messages_run_direction"
  ON "app"."run_messages" ("run_id", "direction");
