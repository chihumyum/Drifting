CREATE TABLE `yjs_sync_cursor` (
	`doc_id` text PRIMARY KEY NOT NULL,
	`last_server_seq` integer DEFAULT 0 NOT NULL,
	`last_pushed_local_id` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
