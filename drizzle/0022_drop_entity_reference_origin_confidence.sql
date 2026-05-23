-- Drop the `origin` and `confidence` columns from entity_reference. Neither
-- ever drove user-facing behavior: `confidence` was always written as null;
-- `origin` had three nominal values ('manual' | 'auto' | 'ai') but the
-- consuming render path (SuperElementView) only saw rows with fromBlockId
-- IS NULL, which are exclusively 'manual'. The auto-detect-marker pipeline
-- still produced 'auto' rows for inline mentions, but nothing read that
-- value downstream. 'ai' was never written by any code path. See conversation
-- notes for the full audit.
ALTER TABLE `entity_reference` DROP COLUMN `origin`;--> statement-breakpoint
ALTER TABLE `entity_reference` DROP COLUMN `confidence`;
