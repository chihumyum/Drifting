-- Device-local state of the library itself, outside every project
-- (docs/sample-project.md). Additive only. One JSON value per key;
-- `built-in-sample` records whether this library ever created, or deliberately
-- skipped, its first-run sample project, so deleting the sample never brings it
-- back. Never synced, never part of the authored journal or workspace projection.
CREATE TABLE `library_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
