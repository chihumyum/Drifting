-- Step 1 of the mainStorylineId → node_storyline_link collapse.
--
-- Adds an `is_primary` flag to the link table; backfills it from the existing
-- mainStorylineId column on book_node. mainStorylineId is left in place for
-- now (read-path will be migrated in step 2, column dropped in step 4).
--
-- Invariant: at most one is_primary=true row per node, enforced by the
-- partial unique index below.

ALTER TABLE `node_storyline_link` ADD COLUMN `is_primary` integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Backfill: for every book_node row with main_storyline_id set, mark the
-- corresponding link row as primary. The link row is guaranteed to exist
-- because useBookNode currently dual-writes (book_node + link insert).
UPDATE `node_storyline_link`
SET `is_primary` = 1
WHERE (`node_id`, `storyline_id`) IN (
  SELECT `id`, `main_storyline_id`
  FROM `book_node`
  WHERE `main_storyline_id` IS NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX `uniq_node_primary_storyline`
  ON `node_storyline_link` (`node_id`)
  WHERE `is_primary` = 1;
