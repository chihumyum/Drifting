CREATE TABLE `manuscript_comment` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`target_block_id` text NOT NULL,
	`anchor_json` text DEFAULT '{}' NOT NULL,
	`author_kind` text DEFAULT 'user' NOT NULL,
	`author_id` text,
	`author_name` text,
	`body_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`metadata_json` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_comment_project` ON `manuscript_comment` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_comment_target` ON `manuscript_comment` (`target_kind`,`target_id`);
--> statement-breakpoint
CREATE INDEX `idx_comment_block` ON `manuscript_comment` (`target_kind`,`target_id`,`target_block_id`);
--> statement-breakpoint
CREATE INDEX `idx_comment_project_status` ON `manuscript_comment` (`project_id`,`status`);
--> statement-breakpoint
CREATE TABLE `comment_action` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_json` text,
	`created_by_kind` text DEFAULT 'user' NOT NULL,
	`created_by_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`applied_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comment_id`) REFERENCES `manuscript_comment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_comment_action_comment` ON `comment_action` (`comment_id`);
--> statement-breakpoint
CREATE INDEX `idx_comment_action_project` ON `comment_action` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_comment_action_status` ON `comment_action` (`status`);
