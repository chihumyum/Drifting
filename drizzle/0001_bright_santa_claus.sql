CREATE TABLE `yjs_snapshots` (
	`document_id` text PRIMARY KEY NOT NULL,
	`state_blob` blob NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_yjs_snapshot_doc` ON `yjs_snapshots` (`document_id`);--> statement-breakpoint
CREATE TABLE `yjs_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`update_blob` blob NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_yjs_updates_doc` ON `yjs_updates` (`document_id`);