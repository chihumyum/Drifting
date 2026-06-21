-- Drift groups — nested folders for organizing drift nodes in the left panel.
-- Multi-level via parent_group_id (NULL = root-level group). Drift-only:
-- chapters never carry a drift_group_id. Membership lives on
-- book_node.drift_group_id. Cascades are client-side (useDriftGroup reparents a
-- deleted group's child groups + drifts up to its parent); the only declarative
-- FK is project_id (cascade) so a project delete sweeps its groups. PRAGMA
-- foreign_keys is off in this app, so parent_group_id / drift_group_id are
-- plain indexed columns, not enforced FKs.

CREATE TABLE `drift_group` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_group_id` text,
	`color` text,
	`sort_order` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_drift_group_project` ON `drift_group` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_drift_group_parent` ON `drift_group` (`parent_group_id`);--> statement-breakpoint
ALTER TABLE `book_node` ADD COLUMN `drift_group_id` text;--> statement-breakpoint
CREATE INDEX `idx_book_node_drift_group` ON `book_node` (`drift_group_id`);
