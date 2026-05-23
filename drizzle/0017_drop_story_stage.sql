-- StoryStage was wired through schema + repo + sync but had no UI entry —
-- users could never create a stage, so book_node.story_stage_id was always
-- NULL in practice. Removing the feature entirely.
--
-- SQLite cannot DROP COLUMN when the column is part of the table's FK
-- definition, even if the index is dropped first. Rebuild book_node instead
-- so the new table definition omits both the column and the FK clause.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE IF EXISTS `__new_book_node`;--> statement-breakpoint
CREATE TABLE `__new_book_node` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`book_order` integer NOT NULL,
	`narrative_order` integer,
	`project_id` text NOT NULL,
	`main_storyline_id` text,
	`word_count` integer DEFAULT 0 NOT NULL,
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
	`created_at`,
	`updated_at`,
	`position_x`,
	`position_y`
)
SELECT
	`id`,
	`title`,
	`summary`,
	`book_order`,
	`narrative_order`,
	`project_id`,
	`main_storyline_id`,
	`word_count`,
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
CREATE INDEX `idx_book_node_project_narrative_order` ON `book_node` (`project_id`,`narrative_order`);--> statement-breakpoint
DROP TABLE IF EXISTS `story_stages`;
