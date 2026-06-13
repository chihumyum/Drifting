-- Act ↔ drift binding. A book_act may bind a drift node as its free-form
-- notes / 大纲 (mirrors timeline_marker.drift_node_id). SET NULL is
-- declarative only (PRAGMA foreign_keys is off) — unbind on drift delete /
-- drift→chapter conversion happens client-side in useBookAct.

ALTER TABLE `book_act` ADD COLUMN `drift_node_id` text REFERENCES `book_node`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `idx_book_act_drift` ON `book_act` (`drift_node_id`);
