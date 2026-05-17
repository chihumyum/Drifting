CREATE TABLE `element_patch` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`element_id` text NOT NULL,
	`source_node_id` text,
	`source_block_id` text,
	`title` text,
	`content_json` text DEFAULT '{}' NOT NULL,
	`order_key` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`element_id`) REFERENCES `element`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_patch_element` ON `element_patch` (`element_id`);--> statement-breakpoint
CREATE INDEX `idx_patch_source_node` ON `element_patch` (`source_node_id`);--> statement-breakpoint
CREATE INDEX `idx_patch_project` ON `element_patch` (`project_id`);--> statement-breakpoint
CREATE TABLE `entity_reference` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_kind` text NOT NULL,
	`from_id` text NOT NULL,
	`from_block_id` text,
	`from_spans_json` text,
	`to_kind` text NOT NULL,
	`to_id` text NOT NULL,
	`to_block_id` text,
	`origin` text DEFAULT 'manual' NOT NULL,
	`confidence` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ref_from` ON `entity_reference` (`from_kind`,`from_id`);--> statement-breakpoint
CREATE INDEX `idx_ref_to` ON `entity_reference` (`to_kind`,`to_id`);--> statement-breakpoint
CREATE INDEX `idx_ref_project` ON `entity_reference` (`project_id`);--> statement-breakpoint
DROP TABLE `element_occurrence`;--> statement-breakpoint
DROP TABLE `node_element_backlink`;