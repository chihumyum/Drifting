CREATE TABLE `sync_reducer_base` (
	`sync_generation_id` text PRIMARY KEY NOT NULL,
	`profile_key` text NOT NULL,
	`payload_version` integer NOT NULL,
	`pages_cbor` blob NOT NULL,
	`source_checkpoint_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sync_reducer_base_version_check" CHECK("sync_reducer_base"."payload_version" >= 2)
);
--> statement-breakpoint
CREATE TABLE `sync_reducer_snapshot` (
	`sync_generation_id` text NOT NULL,
	`profile_key` text NOT NULL,
	`format_version` integer NOT NULL,
	`codec` text NOT NULL,
	`receipt_count` integer NOT NULL,
	`state_blob` blob NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`sync_generation_id`, `profile_key`),
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sync_reducer_snapshot_codec_check" CHECK("sync_reducer_snapshot"."codec" in ('cbor', 'cbor+gzip')),
	CONSTRAINT "sync_reducer_snapshot_count_check" CHECK("sync_reducer_snapshot"."format_version" >= 1 and "sync_reducer_snapshot"."receipt_count" >= 0)
);
