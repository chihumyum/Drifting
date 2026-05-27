-- Block Section.
--
-- Per-chapter rolling summary of a contiguous range of blocks. Produced as a
-- side-effect of Copilot debounce runs, consumed by later debounces to give
-- the model recent-context without re-feeding raw prose. Validity is tracked
-- by `block_signature` — a hash of (blockIds + current block text). When the
-- recomputed signature on read doesn't match the stored one, the prose has
-- changed and the row is discarded.
--
-- block_ids_json is a JSON-encoded ordered string[]. SQLite can't index
-- inside an array and we don't need it to (lookups are always by chapter +
-- signature recompute, never "find sections containing block X").

CREATE TABLE `block_section` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chapter_id` text NOT NULL,
	`block_ids_json` text NOT NULL,
	`block_signature` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'copilot-rolling' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_block_section_project` ON `block_section` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_block_section_chapter` ON `block_section` (`chapter_id`);
