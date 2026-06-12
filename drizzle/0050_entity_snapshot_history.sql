-- Entity snapshot history — the local "time machine" trail. One row per
-- captured save-point of a prose entity (node/element/storyline/category):
-- full Yjs state blob + contentJson preview (stale-OK, history UI) + a JSON
-- bag of restorable metadata fields at capture time. Captured at most every
-- 15 min per entity when the body actually changed, thinned Time-Machine
-- style, dropped after 30 days. Mirrors the server `entity_snapshot` table.

CREATE TABLE `entity_snapshot_history` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`state_blob` blob NOT NULL,
	`content_json` text,
	`meta_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entity_snapshot_entity` ON `entity_snapshot_history` (`entity_kind`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_entity_snapshot_project` ON `entity_snapshot_history` (`project_id`);
