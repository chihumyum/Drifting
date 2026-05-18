-- Phase 1 of the timeline refactor. Two axes now live on book_node:
--   * book_order      — pure sortable integer for reading sequence (was `start`)
--   * narrative_order — author-defined narrative timeline position (nullable, NEW)
-- The old `end` column is dropped: tiles are fixed-width now, so the
-- start/end "video clip" duration metaphor has no remaining users.
DROP INDEX IF EXISTS `idx_book_node_project_start`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_book_node_project_end`;--> statement-breakpoint
ALTER TABLE `book_node` RENAME COLUMN `start` TO `book_order`;--> statement-breakpoint
ALTER TABLE `book_node` DROP COLUMN `end`;--> statement-breakpoint
ALTER TABLE `book_node` ADD COLUMN `narrative_order` integer;--> statement-breakpoint
CREATE INDEX `idx_book_node_project_book_order` ON `book_node` (`project_id`,`book_order`);--> statement-breakpoint
CREATE INDEX `idx_book_node_project_narrative_order` ON `book_node` (`project_id`,`narrative_order`);
