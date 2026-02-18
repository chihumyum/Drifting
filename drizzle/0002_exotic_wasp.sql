PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_yjs_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`update_blob` blob NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_yjs_updates`("id", "document_id", "update_blob", "created_at") SELECT "id", "document_id", "update_blob", "created_at" FROM `yjs_updates`;--> statement-breakpoint
DROP TABLE `yjs_updates`;--> statement-breakpoint
ALTER TABLE `__new_yjs_updates` RENAME TO `yjs_updates`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_yjs_updates_doc` ON `yjs_updates` (`document_id`);