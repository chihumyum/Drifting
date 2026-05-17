-- Make book_node.main_storyline_id nullable and switch FK to ON DELETE SET NULL.
-- Drift nodes (free-floating inspiration notes) have main_storyline_id IS NULL.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_book_node` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`start` integer NOT NULL,
	`end` integer DEFAULT 0 NOT NULL,
	`project_id` text NOT NULL,
	`story_stage_id` text,
	`main_storyline_id` text,
	`word_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`position_x` real NOT NULL,
	`position_y` real NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_stage_id`) REFERENCES `story_stages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`main_storyline_id`) REFERENCES `storylines`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_book_node`("id","title","summary","start","end","project_id","story_stage_id","main_storyline_id","word_count","created_at","updated_at","position_x","position_y")
SELECT "id","title","summary","start","end","project_id","story_stage_id","main_storyline_id","word_count","created_at","updated_at","position_x","position_y" FROM `book_node`;--> statement-breakpoint
DROP TABLE `book_node`;--> statement-breakpoint
ALTER TABLE `__new_book_node` RENAME TO `book_node`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_book_node_project` ON `book_node` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_book_node_stage` ON `book_node` (`story_stage_id`);--> statement-breakpoint
CREATE INDEX `idx_book_node_project_start` ON `book_node` (`project_id`,`start`);--> statement-breakpoint
CREATE INDEX `idx_book_node_project_end` ON `book_node` (`project_id`,`end`);
