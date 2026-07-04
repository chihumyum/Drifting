-- Generalize project_asset from element portraits to project-level R2 assets.
-- Existing portrait rows keep display + thumbnail keys; new library materials
-- may use source-only (PDF) or source + display + thumbnail (images).

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE `__new_project_asset` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `kind` text DEFAULT 'image' NOT NULL,
  `role` text DEFAULT 'element_portrait' NOT NULL,
  `owner_kind` text NOT NULL,
  `owner_id` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `source_object_key` text,
  `display_object_key` text,
  `thumbnail_object_key` text,
  `source_mime` text,
  `display_mime` text,
  `thumbnail_mime` text,
  `source_size_bytes` integer,
  `display_size_bytes` integer,
  `thumbnail_size_bytes` integer,
  `source_sha256` text,
  `width` integer,
  `height` integer,
  `completed_at` text,
  `deleted_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint

INSERT INTO `__new_project_asset` (
  `id`, `project_id`, `kind`, `role`, `owner_kind`, `owner_id`, `status`,
  `source_object_key`, `display_object_key`, `thumbnail_object_key`,
  `source_mime`, `display_mime`, `thumbnail_mime`,
  `source_size_bytes`, `display_size_bytes`, `thumbnail_size_bytes`,
  `source_sha256`, `width`, `height`, `completed_at`, `deleted_at`,
  `created_at`, `updated_at`
)
SELECT
  `id`, `project_id`, `kind`, `role`, `owner_kind`, `owner_id`, `status`,
  NULL, `display_object_key`, `thumbnail_object_key`,
  `source_mime`, `display_mime`, `thumbnail_mime`,
  `source_size_bytes`, `display_size_bytes`, `thumbnail_size_bytes`,
  NULL, `width`, `height`, `completed_at`, `deleted_at`,
  `created_at`, `updated_at`
FROM `project_asset`;
--> statement-breakpoint

DROP TABLE `project_asset`;
--> statement-breakpoint

ALTER TABLE `__new_project_asset` RENAME TO `project_asset`;
--> statement-breakpoint

CREATE INDEX `idx_project_asset_project` ON `project_asset` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_project_asset_owner` ON `project_asset` (`owner_kind`,`owner_id`);
--> statement-breakpoint
CREATE INDEX `idx_project_asset_status` ON `project_asset` (`status`);
--> statement-breakpoint

ALTER TABLE `library_item` ADD COLUMN `asset_id` text REFERENCES `project_asset`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `idx_library_item_asset` ON `library_item` (`asset_id`);
