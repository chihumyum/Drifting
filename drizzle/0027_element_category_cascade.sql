-- Switch element.category_id FK from `ON DELETE SET NULL` to `ON DELETE CASCADE`.
--
-- The column is NOT NULL, so the historical SET NULL action was unusable:
-- it raised "NOT NULL constraint failed: element.category_id" whenever a
-- category with elements was deleted (including transitively from a
-- project delete, which cascades to element_category first). That made
-- project deletion impossible whenever the project had at least one element.
--
-- SQLite can't ALTER a FOREIGN KEY in place, so we use the table-rebuild
-- pattern. `defer_foreign_keys = ON` lets the DROP + RENAME run inside the
-- migration's transaction without tripping FKs that point AT element
-- (entity_reference, element_patch, element_occurrence) which would
-- otherwise dangle for the few statements between DROP and RENAME.

PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE `__new_element` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `category_id` text NOT NULL,
  `name` text NOT NULL,
  `summary` text DEFAULT '' NOT NULL,
  `content_json` text DEFAULT '{}' NOT NULL,
  `kv_json` text DEFAULT '[]' NOT NULL,
  `group_name` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`category_id`) REFERENCES `element_category`(`id`) ON UPDATE no action ON DELETE cascade
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
