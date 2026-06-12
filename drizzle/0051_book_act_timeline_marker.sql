-- Acts (幕) + synced timeline markers.
--
-- book_act: boundary-based segments of the global reading axis. Only the
-- START of an act is stored (`start_order`, REAL so boundaries can sit at
-- fractional midpoints between adjacent integer bookOrders); membership is
-- derived: bookOrder >= start_order and < next act's start_order. One act
-- per project may have start_order = NULL — the opener (book head). Empty
-- acts are legal (planned 幕 with no chapters yet).
--
-- timeline_marker: the narrative-axis time pins, promoted from localStorage
-- to a synced table. New: drift_node_id optionally binds a drift node as the
-- marker's content (pin shows the drift's title; click opens its editor).
-- Bound-ness is always derived from this column. The SET NULL FK is
-- declarative only (PRAGMA foreign_keys is off) — unbinding on drift delete
-- and drift→chapter conversion happens in the usecases.

CREATE TABLE `book_act` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`color` text,
	`start_order` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_book_act_project` ON `book_act` (`project_id`);--> statement-breakpoint
CREATE TABLE `timeline_marker` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`narrative_order` real NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`drift_node_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (`drift_node_id`) REFERENCES `book_node`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `idx_timeline_marker_project` ON `timeline_marker` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_timeline_marker_drift` ON `timeline_marker` (`drift_node_id`);
