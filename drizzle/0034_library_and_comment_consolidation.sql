-- TODO/Comment consolidation: memo → comment (kind='todo'), material →
-- library_item, manuscript_comment → comment. Comment now hosts {block-anchored
-- notes, chapter-anchored TODOs, floating TODOs}; target_* are nullable so a
-- row uses whichever anchor depth it needs. ANNOTATIVE_ENTITY_KINDS becomes
-- [comment, library_item]; entity_relation rows with from_kind='memo' are
-- dropped (no migration of memo bodies per the consolidation plan), and
-- from_kind='material' is rewritten to 'library_item' in place.
--
-- Better-sqlite3 has foreign_keys OFF by default so the rebuild below doesn't
-- need to toggle the pragma. The manuscript_comment → comment rename happens
-- BEFORE the rebuild so SQLite auto-rewrites the FK in comment_action.

DROP TABLE `memo`;
--> statement-breakpoint

DELETE FROM `entity_relation` WHERE `from_kind` = 'memo';
--> statement-breakpoint

UPDATE `entity_relation` SET `from_kind` = 'library_item' WHERE `from_kind` = 'material';
--> statement-breakpoint

DROP INDEX `idx_material_project`;
--> statement-breakpoint
DROP INDEX `idx_material_project_kind`;
--> statement-breakpoint
ALTER TABLE `material` RENAME TO `library_item`;
--> statement-breakpoint
CREATE INDEX `idx_library_item_project` ON `library_item` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_library_item_project_kind` ON `library_item` (`project_id`, `kind`);
--> statement-breakpoint

-- Rename first so the FK in comment_action gets auto-rewritten from
-- "manuscript_comment" to "comment" (SQLite ALTER TABLE ... RENAME TO
-- propagates into FK declarations).
ALTER TABLE `manuscript_comment` RENAME TO `comment`;
--> statement-breakpoint

-- Rebuild to add `kind` and relax NOT NULL on target_* (SQLite cannot
-- ALTER COLUMN to drop NOT NULL). Existing rows all have block anchors;
-- they get kind='note'.
CREATE TABLE `comment_new` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `kind` text NOT NULL DEFAULT 'note',
  `target_kind` text,
  `target_id` text,
  `target_block_id` text,
  `anchor_json` text NOT NULL DEFAULT '{}',
  `author_kind` text NOT NULL DEFAULT 'user',
  `author_id` text,
  `author_name` text,
  `body_json` text NOT NULL DEFAULT '{}',
  `status` text NOT NULL DEFAULT 'open',
  `priority` text,
  `source` text NOT NULL DEFAULT 'manual',
  `metadata_json` text,
  `resolved_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `comment_new` (
  `id`, `project_id`, `kind`, `target_kind`, `target_id`, `target_block_id`,
  `anchor_json`, `author_kind`, `author_id`, `author_name`, `body_json`,
  `status`, `priority`, `source`, `metadata_json`, `resolved_at`,
  `created_at`, `updated_at`
)
SELECT
  `id`, `project_id`, 'note', `target_kind`, `target_id`, `target_block_id`,
  `anchor_json`, `author_kind`, `author_id`, `author_name`, `body_json`,
  `status`, `priority`, `source`, `metadata_json`, `resolved_at`,
  `created_at`, `updated_at`
FROM `comment`;
--> statement-breakpoint
DROP TABLE `comment`;
--> statement-breakpoint
ALTER TABLE `comment_new` RENAME TO `comment`;
--> statement-breakpoint
CREATE INDEX `idx_comment_project` ON `comment` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_comment_target` ON `comment` (`target_kind`, `target_id`);
--> statement-breakpoint
CREATE INDEX `idx_comment_block` ON `comment` (`target_kind`, `target_id`, `target_block_id`);
--> statement-breakpoint
CREATE INDEX `idx_comment_project_status` ON `comment` (`project_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_comment_project_kind_status` ON `comment` (`project_id`, `kind`, `status`);
