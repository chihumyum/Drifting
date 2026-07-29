-- A durable Yjs generation cannot be derived from yjs_updates.id because
-- compaction legitimately deletes covered update rows. Keep a monotonic
-- counter beside the snapshot/update log and retain command receipts for
-- crash reconciliation and idempotent replay.

CREATE TABLE `yjs_document_revision` (
	`document_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	CHECK (`revision` >= 0)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `yjs_document_revision`
	(`document_id`, `revision`, `updated_at`)
SELECT `document_id`, 0, `updated_at`
FROM `yjs_snapshots`;
--> statement-breakpoint
INSERT OR IGNORE INTO `yjs_document_revision`
	(`document_id`, `revision`, `updated_at`)
SELECT `document_id`, 0, max(`created_at`)
FROM `yjs_updates`
GROUP BY `document_id`;
--> statement-breakpoint

CREATE TABLE `yjs_prose_command_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`direction` text NOT NULL,
	`document_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`base_revision` integer NOT NULL,
	`committed_revision` integer NOT NULL,
	`base_state_vector` blob NOT NULL,
	`base_state_hash` text NOT NULL,
	`result_state_vector` blob NOT NULL,
	`result_state_hash` text NOT NULL,
	`update_hash` text NOT NULL,
	`update_id` integer NOT NULL,
	`created_at` text NOT NULL,
	CHECK (`direction` IN ('forward', 'inverse')),
	CHECK (`source_kind` IN ('live', 'closed', 'seed')),
	CHECK (`base_revision` >= 0),
	CHECK (`committed_revision` > `base_revision`),
	CHECK (length(`command_id`) > 0),
	CHECK (length(`base_state_hash`) > 0),
	CHECK (length(`result_state_hash`) > 0),
	CHECK (length(`update_hash`) > 0),
	CHECK (`update_id` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_yjs_prose_command_direction`
	ON `yjs_prose_command_receipt` (`command_id`,`direction`);
--> statement-breakpoint
CREATE INDEX `idx_yjs_prose_command_doc_revision`
	ON `yjs_prose_command_receipt` (`document_id`,`committed_revision`);
