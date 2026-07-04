-- Element portrait assets — private R2-backed image metadata.
-- Binary bytes live in R2; SQLite stores only object keys and display metadata.

CREATE TABLE `project_asset` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text DEFAULT 'image' NOT NULL,
	`role` text DEFAULT 'element_portrait' NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`original_object_key` text NOT NULL,
	`thumbnail_object_key` text NOT NULL,
	`original_mime` text NOT NULL,
	`thumbnail_mime` text DEFAULT 'image/png' NOT NULL,
	`original_size_bytes` integer,
	`thumbnail_size_bytes` integer,
	`width` integer,
	`height` integer,
	`completed_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_project_asset_project` ON `project_asset` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_project_asset_owner` ON `project_asset` (`owner_kind`,`owner_id`);
--> statement-breakpoint
CREATE INDEX `idx_project_asset_status` ON `project_asset` (`status`);
--> statement-breakpoint
ALTER TABLE `element` ADD COLUMN `portrait_asset_id` text REFERENCES `project_asset`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `idx_element_portrait_asset` ON `element` (`portrait_asset_id`);
