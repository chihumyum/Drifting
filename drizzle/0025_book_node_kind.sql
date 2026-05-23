-- Step 3 of the mainStorylineId → node_storyline_link collapse.
--
-- Adds an explicit `kind` column to book_node, replacing "mainStorylineId
-- nullability" as the chapter/drift discriminator. After this step,
-- normalizeBookNode no longer auto-coerces — a chapter without a primary
-- storyline remains a chapter (this enables the "未归属" lane in Step 5).
--
-- Default 'drift' is harmless because the backfill UPDATE immediately
-- promotes every row that currently has a mainStorylineId to 'chapter'.

ALTER TABLE `book_node` ADD COLUMN `kind` text NOT NULL DEFAULT 'drift';
--> statement-breakpoint

UPDATE `book_node` SET `kind` = 'chapter' WHERE `main_storyline_id` IS NOT NULL;
