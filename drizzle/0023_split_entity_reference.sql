-- Split `entity_reference` into two purpose-built tables:
--
--   entity_relation  — user-curated cross-entity links (memo→node, material→
--                      element, story-graph edges, etc.). Source of truth.
--   inline_mention   — derived index of entityLink marks projected from
--                      manuscript content. Rebuilt from the doc on every save.
--
-- The legacy entity_reference column `to_block_id` is dropped entirely; no UI
-- ever wrote a non-null value through any production code path. Rows with
-- from_block_id IS NULL become entity_relation rows; rows with non-null
-- from_block_id AND non-null from_spans_json become inline_mention rows.
-- Defensive: rows that don't fit either shape are skipped.

CREATE TABLE `entity_relation` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `from_kind` text NOT NULL,
  `from_id` text NOT NULL,
  `to_kind` text NOT NULL,
  `to_id` text NOT NULL,
  `kind` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_relation_from` ON `entity_relation` (`from_kind`, `from_id`);--> statement-breakpoint
CREATE INDEX `idx_relation_to` ON `entity_relation` (`to_kind`, `to_id`);--> statement-breakpoint
CREATE INDEX `idx_relation_project` ON `entity_relation` (`project_id`);--> statement-breakpoint

CREATE TABLE `inline_mention` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `from_kind` text NOT NULL,
  `from_id` text NOT NULL,
  `from_block_id` text NOT NULL,
  `from_spans_json` text NOT NULL,
  `to_kind` text NOT NULL,
  `to_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mention_from` ON `inline_mention` (`from_kind`, `from_id`);--> statement-breakpoint
CREATE INDEX `idx_mention_to` ON `inline_mention` (`to_kind`, `to_id`);--> statement-breakpoint
CREATE INDEX `idx_mention_project` ON `inline_mention` (`project_id`);--> statement-breakpoint

INSERT INTO `entity_relation` (
  `id`, `project_id`, `from_kind`, `from_id`, `to_kind`, `to_id`, `kind`, `created_at`, `updated_at`
)
SELECT
  `id`, `project_id`, `from_kind`, `from_id`, `to_kind`, `to_id`, `kind`, `created_at`, `updated_at`
FROM `entity_reference`
WHERE `from_block_id` IS NULL;
--> statement-breakpoint

INSERT INTO `inline_mention` (
  `id`, `project_id`, `from_kind`, `from_id`, `from_block_id`, `from_spans_json`, `to_kind`, `to_id`, `created_at`, `updated_at`
)
SELECT
  `id`, `project_id`, `from_kind`, `from_id`, `from_block_id`, `from_spans_json`, `to_kind`, `to_id`, `created_at`, `updated_at`
FROM `entity_reference`
WHERE `from_block_id` IS NOT NULL AND `from_spans_json` IS NOT NULL;
--> statement-breakpoint

DROP TABLE `entity_reference`;
