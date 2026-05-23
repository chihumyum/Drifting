-- Trash columns + element.category_id nullable.
--
-- Adds deleted_at (TEXT, nullable) to the 4 client-side core domain tables.
-- Rebuilds the `element` table so category_id is nullable and its FK uses
-- ON DELETE SET NULL — when a category is hard-deleted, its elements detach
-- to the "未分类" bucket (null categoryId) instead of cascading.

ALTER TABLE `book_node` ADD COLUMN `deleted_at` text;
--> statement-breakpoint
ALTER TABLE `storylines` ADD COLUMN `deleted_at` text;
--> statement-breakpoint
ALTER TABLE `element_category` ADD COLUMN `deleted_at` text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_book_node_deleted_at` ON `book_node` (`deleted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_storyline_deleted_at` ON `storylines` (`deleted_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_element_category_deleted_at` ON `element_category` (`deleted_at`);
--> statement-breakpoint

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE `__new_element` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `category_id` text,
  `name` text NOT NULL,
  `summary` text DEFAULT '' NOT NULL,
  `content_json` text DEFAULT '{}' NOT NULL,
  `kv_json` text DEFAULT '[]' NOT NULL,
  `group_name` text,
  `deleted_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`category_id`) REFERENCES `element_category`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint

INSERT INTO `__new_element` (
  `id`, `project_id`, `category_id`, `name`, `summary`, `content_json`,
  `kv_json`, `group_name`, `created_at`, `updated_at`
)
SELECT
  `id`, `project_id`, `category_id`, `name`, `summary`, `content_json`,
  `kv_json`, `group_name`, `created_at`, `updated_at`
FROM `element`;
--> statement-breakpoint

DROP TABLE `element`;
--> statement-breakpoint

ALTER TABLE `__new_element` RENAME TO `element`;
--> statement-breakpoint

CREATE INDEX `idx_element_deleted_at` ON `element` (`deleted_at`);
--> statement-breakpoint
CREATE INDEX `idx_element_category` ON `element` (`category_id`);
