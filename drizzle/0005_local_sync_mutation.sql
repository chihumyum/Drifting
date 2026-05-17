CREATE TABLE `local_sync_mutation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`mutation_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`payload_json` text,
	`mutation_ts` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_local_sync_mutation_status_id` ON `local_sync_mutation` (`status`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_local_sync_mutation_project` ON `local_sync_mutation` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_local_sync_mutation_entity` ON `local_sync_mutation` (`entity_type`,`entity_id`,`mutation_type`);
