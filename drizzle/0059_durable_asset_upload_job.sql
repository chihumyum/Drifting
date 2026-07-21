-- Device-local durable queue for native project-asset uploads. Presigned URLs
-- remain memory-only; app-owned import/cache paths and workflow state survive
-- process restarts.

CREATE TABLE `asset_upload_job` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `owner_kind` text NOT NULL,
  `owner_id` text NOT NULL,
  `kind` text NOT NULL,
  `role` text NOT NULL,
  `stage` text DEFAULT 'queued' NOT NULL,
  `source_path` text NOT NULL,
  `source_mime` text,
  `source_size_bytes` integer,
  `display_mime` text,
  `display_size_bytes` integer,
  `thumbnail_mime` text,
  `thumbnail_size_bytes` integer,
  `width` integer,
  `height` integer,
  `asset_id` text,
  `previous_asset_id` text,
  `delete_previous_asset_on_cancel` integer DEFAULT 0 NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_asset_upload_job_owner` ON `asset_upload_job` (`project_id`,`owner_kind`,`owner_id`);
--> statement-breakpoint
CREATE INDEX `idx_asset_upload_job_project_stage` ON `asset_upload_job` (`project_id`,`stage`);
