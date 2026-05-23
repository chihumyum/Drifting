-- bookOrder no longer applies to drift nodes (free-floating inspiration notes
-- with no main storyline). Drift nodes don't appear on the timeline or graph
-- view's order axis, so the shared integer was a phantom — pushing chapter
-- order forward whenever a drift was created and showing up as "§ N" labels
-- in places that only made sense for chapters. Make the column nullable and
-- backfill existing drift rows to NULL.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE IF EXISTS `__new_book_node`;--> statement-breakpoint
CREATE TABLE `__new_book_node` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`book_order` integer,
	`narrative_order` integer,
	`project_id` text NOT NULL,
	`main_storyline_id` text,
	`word_count` integer DEFAULT 0 NOT NULL,
	`writing_status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`position_x` real NOT NULL,
	`position_y` real NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`main_storyline_id`) REFERENCES `storylines`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_book_node` (
	`id`,
	`title`,
	`summary`,
	`book_order`,
	`narrative_order`,
	`project_id`,
	`main_storyline_id`,
	`word_count`,
	`writing_status`,
	`created_at`,
	`updated_at`,
	`position_x`,
	`position_y`
)
SELECT
	`id`,
	`title`,
	`summary`,
	CASE WHEN `main_storyline_id` IS NULL THEN NULL ELSE `book_order` END,
	`narrative_order`,
	`project_id`,
	`main_storyline_id`,
	`word_count`,
	`writing_status`,
	`created_at`,
	`updated_at`,
	`position_x`,
	`position_y`
FROM `book_node`;--> statement-breakpoint
DROP TABLE `book_node`;--> statement-breakpoint
ALTER TABLE `__new_book_node` RENAME TO `book_node`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_book_node_project` ON `book_node` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_book_node_project_book_order` ON `book_node` (`project_id`,`book_order`);--> statement-breakpoint
CREATE INDEX `idx_book_node_project_narrative_order` ON `book_node` (`project_id`,`narrative_order`);
