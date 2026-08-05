-- Keep the author of each semantic Yjs revision after update-log compaction.
-- Existing revisions cannot be attributed safely and are marked legacy rather
-- than guessed to be user or Agent changes.
CREATE TABLE `yjs_document_revision_provenance` (
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`source_kind` text NOT NULL,
	`agent_session_id` text,
	`agent_turn_id` text,
	`agent_call_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`document_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `idx_yjs_revision_provenance_doc_revision`
	ON `yjs_document_revision_provenance` (`document_id`,`revision`);
--> statement-breakpoint
INSERT OR IGNORE INTO `yjs_document_revision_provenance` (
	`document_id`,
	`revision`,
	`source_kind`,
	`created_at`
)
SELECT
	`document_id`,
	`revision`,
	'legacy',
	`updated_at`
FROM `yjs_document_revision`
WHERE `revision` > 0;
