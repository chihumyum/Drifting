-- Device-local ledger for the project Markdown folder (docs/markdown-mirror.md).
-- Additive only. One row per authored file records the Yjs state whose
-- rendering that file holds, so an edit made in another editor merges into
-- Yjs as a peer that last synced at that state. pending_* records a write that
-- has not been confirmed yet; a crash between writing the file and confirming
-- it must not read Drifting's own bytes back as an external edit.
-- Never synced, never part of the workspace projection journal.
CREATE TABLE `markdown_mirror_file` (
	`project_id` text NOT NULL,
	`document_id` text NOT NULL,
	`directory` text NOT NULL,
	`path` text NOT NULL,
	`file_sha256` text NOT NULL,
	`base_state` blob NOT NULL,
	`base_fields_json` text NOT NULL,
	`pending_sha256` text,
	`pending_path` text,
	`pending_state` blob,
	`pending_fields_json` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `document_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_markdown_mirror_file_document` ON `markdown_mirror_file` (`document_id`);