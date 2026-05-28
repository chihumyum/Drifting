-- Block-section per-block hashes.
--
-- Replaces the single `block_signature` column (was: hash of all blockIds +
-- all block texts combined) with a per-block hash map. This lets the
-- coverage-map computation invalidate individual blocks inside a section
-- without dropping the section's summary entirely. A mid-chapter edit on
-- one block now exposes ONLY that block as "uncovered" — the section's
-- summary still provides context for the unchanged blocks around it.

ALTER TABLE `block_section` DROP COLUMN `block_signature`;
--> statement-breakpoint
ALTER TABLE `block_section` ADD COLUMN `block_hashes_json` text DEFAULT '{}' NOT NULL;
