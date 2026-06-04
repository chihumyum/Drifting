CREATE TABLE `shadow_job` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chapter_id` text NOT NULL,
	`chapter_title` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`decision` text,
	`finding_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`trace_json` text DEFAULT '[]' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_shadow_job_project` ON `shadow_job` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_shadow_job_chapter` ON `shadow_job` (`chapter_id`);
