-- Canonical provider-neutral Agent recovery state. The legacy
-- agent_conversation.messages_json and sdk_session_id columns stay intact
-- during migration; runtime_session_id points new conversations at normalized
-- state without making old display history unreadable.

CREATE TABLE `agent_runtime_session` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`route_kind` text NOT NULL,
	`conversation_id` text,
	`goal_run_id` text,
	`chapter_id` text,
	`provider` text NOT NULL,
	`model` text,
	`provider_epoch` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversation`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`provider_epoch` >= 0),
	CHECK (`route_kind` IN ('chat', 'goal')),
	CHECK (
		(`route_kind` = 'chat' AND `goal_run_id` IS NULL AND `chapter_id` IS NULL)
		OR
		(`route_kind` = 'goal' AND `conversation_id` IS NULL)
	),
	CHECK (`status` IN ('pending', 'idle', 'running', 'recovering', 'interrupted', 'closed', 'failed', 'aborted'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_project` ON `agent_runtime_session` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_conversation` ON `agent_runtime_session` (`conversation_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_goal` ON `agent_runtime_session` (`project_id`,`goal_run_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_recovery` ON `agent_runtime_session` (`project_id`,`status`,`updated_at`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_turn` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`prompt_message_id` text,
	`accepted_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`error_code` text,
	`error_message` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_runtime_session`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`ordinal` >= 0),
	CHECK (`status` IN ('accepted', 'running', 'recovering', 'completed', 'interrupted', 'failed', 'aborted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_turn_session_ordinal` ON `agent_runtime_turn` (`session_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_turn_session_status` ON `agent_runtime_turn` (`session_id`,`status`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`ordinal` integer NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`content_json` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `agent_runtime_session`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (`turn_id`) REFERENCES `agent_runtime_turn`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`ordinal` >= 0),
	CHECK (`role` IN ('system', 'user', 'assistant', 'tool')),
	CHECK (`status` IN ('accepted', 'streaming', 'complete', 'interrupted', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_message_session_ordinal` ON `agent_runtime_message` (`session_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_message_turn_ordinal` ON `agent_runtime_message` (`turn_id`,`ordinal`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_event` (
	`event_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`seq` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`wall_time_ms` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_runtime_session`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (`turn_id`) REFERENCES `agent_runtime_turn`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`seq` > 0),
	CHECK (`schema_version` > 0),
	CHECK (`wall_time_ms` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_event_turn_seq` ON `agent_runtime_event` (`turn_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_event_session` ON `agent_runtime_event` (`session_id`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_tool_call` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`call_id` text NOT NULL,
	`name` text NOT NULL,
	`access` text NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`idempotency_key` text NOT NULL,
	`arguments_json` text NOT NULL,
	`result_json` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `agent_runtime_session`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (`turn_id`) REFERENCES `agent_runtime_turn`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`access` IN ('read', 'write')),
	CHECK (`status` IN ('requested', 'running', 'completed', 'failed', 'interrupted', 'uncertain'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_tool_call_session_call` ON `agent_runtime_tool_call` (`session_id`,`call_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_tool_call_idempotency` ON `agent_runtime_tool_call` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_tool_call_turn_status` ON `agent_runtime_tool_call` (`turn_id`,`status`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_checkpoint` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`through_turn_ordinal` integer NOT NULL,
	`message_count` integer NOT NULL,
	`context_json` text NOT NULL,
	`context_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_runtime_session`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`through_turn_ordinal` >= 0),
	CHECK (`message_count` >= 0),
	CHECK (length(`context_hash`) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_checkpoint_session_turn` ON `agent_runtime_checkpoint` (`session_id`,`through_turn_ordinal`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_checkpoint_session_created` ON `agent_runtime_checkpoint` (`session_id`,`created_at`);
--> statement-breakpoint

ALTER TABLE `agent_conversation` ADD COLUMN `runtime_session_id` text REFERENCES `agent_runtime_session`(`id`) ON DELETE SET NULL;
