CREATE TABLE `element_occurrence` (
	`id` text PRIMARY KEY NOT NULL,
	`element_id` text NOT NULL,
	`node_id` text NOT NULL,
	`block_id` text DEFAULT '' NOT NULL,
	`spans_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `element`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_element_occurrence_element` ON `element_occurrence` (`element_id`);
--> statement-breakpoint
CREATE INDEX `idx_element_occurrence_node` ON `element_occurrence` (`node_id`);
