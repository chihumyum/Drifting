-- Agent conversation.
--
-- Local-only chat history for the right-sidebar Agent. The display transcript
-- is stored as a JSON blob (messages_json = AgentChatMessage[]); the SDK's own
-- session file remains the source of truth for *resuming* context, pointed at
-- by sdk_session_id. Not synced cross-device. Cascade-deletes with the project.

CREATE TABLE `agent_conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`sdk_session_id` text,
	`mode` text DEFAULT 'byok' NOT NULL,
	`messages_json` text DEFAULT '[]' NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_conversation_project` ON `agent_conversation` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_conversation_project_updated` ON `agent_conversation` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_conversation_deleted_at` ON `agent_conversation` (`deleted_at`);
