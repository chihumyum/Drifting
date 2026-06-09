-- Agent memory — author-level guidance shared by the General agent and the
-- Shadow review engine. NOT canon (the story world) and NOT project facts (the
-- structured governing KV); it holds the standing, cross-cutting meta: personal
-- writing preferences, vetoed proposals, and standing directives. Anchored,
-- block-local guidance lives in `comment` (kind='exception') instead.
--
--   kind:   'preference' | 'veto' | 'directive'   (reserve 'episode' for session memory)
--   status: 'pending' | 'active' | 'dismissed'    — ONLY 'active' is fed to an
--           agent/judge; 'pending' awaits the author's soft-approval.
--   source: 'author' | 'agent'
-- Local-only for now (no sync helper yet); the shape is sync-ready for later.

CREATE TABLE `agent_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`target_kind` text,
	`target_id` text,
	`target_block_id` text,
	`source` text DEFAULT 'agent' NOT NULL,
	`origin_ref` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`supersedes_id` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_agent_memory_project` ON `agent_memory` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_memory_project_status` ON `agent_memory` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_memory_project_kind_status` ON `agent_memory` (`project_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_memory_target` ON `agent_memory` (`target_kind`,`target_id`);