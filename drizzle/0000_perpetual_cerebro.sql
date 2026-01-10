CREATE TABLE `element_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description_json` text DEFAULT '{}',
	`color` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `element_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`element_id` text NOT NULL,
	`order_key` integer NOT NULL,
	`start_node_id` text,
	`end_node_id` text,
	`stage_name` text NOT NULL,
	`content_json` text DEFAULT '{}',
	`summary` text DEFAULT '',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `element_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `element_tags_link` (
	`element_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`element_id`, `tag_id`),
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `element_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `elements` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text,
	`name` text NOT NULL,
	`summary` text DEFAULT '',
	`content_json` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `element_categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `node_contents` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`project_id` text NOT NULL,
	`content_json` text DEFAULT '{}',
	`outline_json` text DEFAULT '[]',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `story_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_node_contents_node` ON `node_contents` (`node_id`);--> statement-breakpoint
CREATE TABLE `node_elements_link` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`element_id` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `story_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `node_storylines` (
	`node_id` text NOT NULL,
	`storyline_id` text NOT NULL,
	PRIMARY KEY(`node_id`, `storyline_id`),
	FOREIGN KEY (`node_id`) REFERENCES `story_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`storyline_id`) REFERENCES `storylines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `node_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `node_tags_link` (
	`node_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`node_id`, `tag_id`),
	FOREIGN KEY (`node_id`) REFERENCES `story_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `node_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`author` text NOT NULL,
	`description_json` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `story_node_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`label` text,
	`weight` integer DEFAULT 1 NOT NULL,
	`is_directed` integer DEFAULT true NOT NULL,
	`style_json` text,
	`control_point_offset_json` text,
	`source_anchor_json` text,
	`target_anchor_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_node_id`) REFERENCES `story_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `story_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `story_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '',
	`start` integer NOT NULL,
	`end` integer,
	`story_stage_id` text,
	`position_x` real NOT NULL,
	`position_y` real NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`story_stage_id`) REFERENCES `story_stages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_story_nodes_project` ON `story_nodes` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_story_nodes_stage` ON `story_nodes` (`story_stage_id`);--> statement-breakpoint
CREATE TABLE `story_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description_json` text DEFAULT '{}',
	`order_key` integer NOT NULL,
	`start_node_id` text,
	`end_node_id` text,
	`color` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `storylines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`summary` text DEFAULT '',
	`description_json` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
