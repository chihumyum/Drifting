CREATE TABLE `element` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category_id` text,
	`name` text NOT NULL,
	`summary` text DEFAULT '',
	`content_json` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `element_category`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `book_node` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '',
	`start` integer NOT NULL,
	`end` integer DEFAULT 0 NOT NULL,
	`project_id` text NOT NULL,
	`story_stage_id` text,
	`main_storyline_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`position_x` real NOT NULL,
	`position_y` real NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_stage_id`) REFERENCES `story_stages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`main_storyline_id`) REFERENCES `storylines`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_book_node_project` ON `book_node` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_book_node_stage` ON `book_node` (`story_stage_id`);--> statement-breakpoint
CREATE INDEX `idx_book_node_project_start` ON `book_node` (`project_id`,`start`);--> statement-breakpoint
CREATE INDEX `idx_book_node_project_end` ON `book_node` (`project_id`,`end`);--> statement-breakpoint
CREATE TABLE `element_category` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description_json` text DEFAULT '{}',
	`color` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_unique_category_per_project` ON `element_category` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_element_category_project` ON `element_category` (`project_id`);--> statement-breakpoint
CREATE TABLE `element_stage` (
	`id` text PRIMARY KEY NOT NULL,
	`element_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`summary` text DEFAULT '',
	`content_json` text DEFAULT '{}',
	`order_key` integer NOT NULL,
	`start_node_id` text,
	`end_node_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `element`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`start_node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`end_node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `element_tag_link` (
	`element_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`element_id`, `tag_id`),
	FOREIGN KEY (`element_id`) REFERENCES `element`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `element_tag`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `element_tag` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_unique_element_tag_per_project` ON `element_tag` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_element_tag_project` ON `element_tag` (`project_id`);--> statement-breakpoint
CREATE TABLE `node_content` (
	`node_id` text PRIMARY KEY NOT NULL,
	`content_json` text DEFAULT '{}',
	`outline_json` text DEFAULT '[]',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_node_content_node` ON `node_content` (`node_id`);--> statement-breakpoint
CREATE TABLE `book_node_edge` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`weight` integer DEFAULT 1 NOT NULL,
	`is_directed` integer DEFAULT true NOT NULL,
	`style_json` text,
	`control_point_offset_json` text,
	`source_anchor_json` text,
	`target_anchor_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_edge_project_source` ON `book_node_edge` (`project_id`,`source_node_id`);--> statement-breakpoint
CREATE INDEX `idx_edge_project_target` ON `book_node_edge` (`project_id`,`target_node_id`);--> statement-breakpoint
CREATE TABLE `node_element_backlink` (
	`node_id` text NOT NULL,
	`element_id` text NOT NULL,
	PRIMARY KEY(`node_id`, `element_id`),
	FOREIGN KEY (`node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`element_id`) REFERENCES `element`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `node_storyline_link` (
	`node_id` text NOT NULL,
	`storyline_id` text NOT NULL,
	PRIMARY KEY(`node_id`, `storyline_id`),
	FOREIGN KEY (`node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`storyline_id`) REFERENCES `storylines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_node_storyline_node` ON `node_storyline_link` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_node_storyline_storyline` ON `node_storyline_link` (`storyline_id`);--> statement-breakpoint
CREATE TABLE `node_tag_link` (
	`node_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`node_id`, `tag_id`),
	FOREIGN KEY (`node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `node_tag`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `node_tag` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_unique_node_tag_per_project` ON `node_tag` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_node_tag_project` ON `node_tag` (`project_id`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description_json` text DEFAULT '{}',
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `story_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description_json` text DEFAULT '{}',
	`order_key` integer NOT NULL,
	`color` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_unique_stage_per_project` ON `story_stages` (`project_id`,`order_key`);--> statement-breakpoint
CREATE INDEX `idx_story_stage_project` ON `story_stages` (`project_id`);--> statement-breakpoint
CREATE TABLE `storylines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`summary` text DEFAULT '',
	`description_json` text DEFAULT '{}',
	`project_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
