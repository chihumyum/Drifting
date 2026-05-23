-- Final step of the mainStorylineId → node_storyline_link collapse.
--
-- Drop the now-unused `main_storyline_id` column. The primary storyline of a
-- node is the row in `node_storyline_link` with `is_primary = 1`.
--
-- SQLite refuses `ALTER TABLE ... DROP COLUMN` on columns that participate in
-- a FOREIGN KEY constraint (here `main_storyline_id REFERENCES storyline(id)`),
-- so we use the classic 12-step rebuild pattern: create a new table without
-- the column, copy rows over, swap. `defer_foreign_keys = ON` lets the DROP +
-- RENAME run inside the migration's transaction without tripping the FKs
-- pointing AT book_node (node_storyline_link, node_content, element_patch),
-- which would otherwise dangle for the few statements between DROP and
-- RENAME. SQLite re-checks all constraints at COMMIT.

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE `__new_book_node` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `summary` text DEFAULT '' NOT NULL,
  `book_order` integer,
  `narrative_order` integer,
  `project_id` text NOT NULL,
  `word_count` integer DEFAULT 0 NOT NULL,
  `writing_status` text DEFAULT 'draft' NOT NULL,
  `kind` text DEFAULT 'drift' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `position_x` real NOT NULL,
  `position_y` real NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

INSERT INTO `__new_book_node` (
  `id`, `title`, `summary`, `book_order`, `narrative_order`, `project_id`,
  `word_count`, `writing_status`, `kind`, `created_at`, `updated_at`,
  `position_x`, `position_y`
)
SELECT
  `id`, `title`, `summary`, `book_order`, `narrative_order`, `project_id`,
  `word_count`, `writing_status`, `kind`, `created_at`, `updated_at`,
  `position_x`, `position_y`
FROM `book_node`;
--> statement-breakpoint

DROP TABLE `book_node`;
--> statement-breakpoint

ALTER TABLE `__new_book_node` RENAME TO `book_node`;
--> statement-breakpoint

CREATE INDEX `idx_book_node_project` ON `book_node` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_book_node_project_book_order` ON `book_node` (`project_id`, `book_order`);
--> statement-breakpoint
CREATE INDEX `idx_book_node_project_narrative_order` ON `book_node` (`project_id`, `narrative_order`);
--> statement-breakpoint
CREATE INDEX `idx_book_node_project_kind` ON `book_node` (`project_id`, `kind`);
