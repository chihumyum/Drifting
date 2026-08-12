CREATE TABLE `agent_working_memory` (
	`project_id` text PRIMARY KEY NOT NULL,
	`content_md` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`approx_tokens` integer DEFAULT 0 NOT NULL,
	`updated_by` text DEFAULT 'agent' NOT NULL,
	`last_compacted_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `agent_working_memory_revision_nonnegative` CHECK (`revision` >= 0),
	CONSTRAINT `agent_working_memory_tokens_nonnegative` CHECK (`approx_tokens` >= 0),
	CONSTRAINT `agent_working_memory_updated_by` CHECK (`updated_by` in ('author', 'agent'))
);
