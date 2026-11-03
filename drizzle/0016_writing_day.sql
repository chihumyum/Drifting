-- Writing days (docs/writing-days.md). Additive only: one new table, the words
-- one device added to one book on one day of its own calendar. Each device
-- writes only its own rows, so a day's words are the sum over devices. Synced
-- and checkpointed with the project; no workspace projection triggers, since
-- the workspace never reads it. The device backfills its earlier local
-- history (localStorage `writing-stats-storage`) once, in application code.
CREATE TABLE `writing_day` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`day` text NOT NULL,
	`device_key` text NOT NULL,
	`words` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_writing_day_project_day` ON `writing_day` (`project_id`,`day`);