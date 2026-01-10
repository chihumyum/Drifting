PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_story_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '',
	`start` integer NOT NULL,
	`end` integer DEFAULT 0 NOT NULL,
	`story_stage_id` text,
	`position_x` real NOT NULL,
	`position_y` real NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_stage_id`) REFERENCES `story_stages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_story_nodes`("id", "project_id", "title", "summary", "start", "end", "story_stage_id", "position_x", "position_y", "created_at", "updated_at") SELECT "id", "project_id", "title", "summary", "start", "end", "story_stage_id", "position_x", "position_y", "created_at", "updated_at" FROM `story_nodes`;--> statement-breakpoint
DROP TABLE `story_nodes`;--> statement-breakpoint
ALTER TABLE `__new_story_nodes` RENAME TO `story_nodes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_story_nodes_project` ON `story_nodes` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_story_nodes_stage` ON `story_nodes` (`story_stage_id`);--> statement-breakpoint
ALTER TABLE `elements` ADD `project_id` text NOT NULL REFERENCES projects(id);--> statement-breakpoint
ALTER TABLE `node_storylines` ADD `storyline_order` integer DEFAULT 0 NOT NULL;