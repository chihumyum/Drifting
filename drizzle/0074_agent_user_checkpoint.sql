ALTER TABLE `agent_conversation` ADD `fork_checkpoint_id` text;
--> statement-breakpoint
ALTER TABLE `agent_conversation` ADD `parent_conversation_id` text;
--> statement-breakpoint
CREATE INDEX `idx_agent_conversation_fork_checkpoint`
	ON `agent_conversation` (`fork_checkpoint_id`);
--> statement-breakpoint
CREATE TABLE `agent_user_checkpoint` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`runtime_session_id` text,
	`source_turn_id` text,
	`parent_checkpoint_id` text,
	`kind` text DEFAULT 'automatic' NOT NULL,
	`status` text DEFAULT 'capturing' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`canonical_through_turn_ordinal` integer DEFAULT -1 NOT NULL,
	`canonical_context_hash` text,
	`conversation_messages_json` text DEFAULT '[]' NOT NULL,
	`provider_history_json` text DEFAULT '[]' NOT NULL,
	`long_task_state_json` text,
	`accepted_write_effect_ids_json` text DEFAULT '[]' NOT NULL,
	`entity_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`finalized_at` text,
	`deleted_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversation`(`id`) ON DELETE CASCADE,
	CHECK (`kind` IN ('automatic', 'manual')),
	CHECK (`status` IN ('capturing', 'ready', 'invalid')),
	CHECK (`canonical_through_turn_ordinal` >= -1),
	CHECK (`entity_count` >= 0),
	CHECK ((`status` = 'ready' AND `finalized_at` IS NOT NULL) OR (`status` != 'ready'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_user_checkpoint_project_created`
	ON `agent_user_checkpoint` (`project_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `idx_agent_user_checkpoint_conversation_created`
	ON `agent_user_checkpoint` (`conversation_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_user_checkpoint_turn_kind`
	ON `agent_user_checkpoint` (`conversation_id`, `source_turn_id`, `kind`);
--> statement-breakpoint
CREATE TABLE `agent_user_checkpoint_entity` (
	`checkpoint_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`project_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`document_id` text NOT NULL,
	`yjs_revision` integer NOT NULL,
	`state_vector` blob NOT NULL,
	`state_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`state_blob` blob NOT NULL,
	`metadata_json` text NOT NULL,
	`metadata_hash` text NOT NULL,
	`captured_at` text NOT NULL,
	PRIMARY KEY (`checkpoint_id`, `entity_kind`, `entity_id`),
	FOREIGN KEY (`checkpoint_id`) REFERENCES `agent_user_checkpoint`(`id`) ON DELETE CASCADE,
	CHECK (`ordinal` >= 0),
	CHECK (`entity_kind` IN ('node', 'element', 'storyline', 'category')),
	CHECK (`yjs_revision` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_user_checkpoint_entity_ordinal`
	ON `agent_user_checkpoint_entity` (`checkpoint_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `idx_agent_user_checkpoint_entity_project`
	ON `agent_user_checkpoint_entity` (`project_id`, `entity_kind`, `entity_id`);
--> statement-breakpoint
CREATE TABLE `agent_user_checkpoint_action` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'previewed' NOT NULL,
	`idempotency_key` text NOT NULL,
	`preview_token_hash` text NOT NULL,
	`preview_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`overwrite_confirmed` integer DEFAULT false NOT NULL,
	`target_conversation_id` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`confirmed_at` text,
	`completed_at` text,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `agent_user_checkpoint`(`id`) ON DELETE CASCADE,
	CHECK (`kind` IN ('conversation_fork', 'manuscript_restore', 'restore_and_fork')),
	CHECK (`status` IN ('previewed', 'applying', 'compensating', 'completed', 'compensated', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_user_checkpoint_action_idempotency`
	ON `agent_user_checkpoint_action` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_agent_user_checkpoint_action_recovery`
	ON `agent_user_checkpoint_action` (`project_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `agent_user_checkpoint_action_entity` (
	`action_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`project_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`expected_current_revision` integer,
	`expected_current_state_hash` text NOT NULL,
	`expected_current_content_hash` text NOT NULL,
	`expected_current_metadata_hash` text NOT NULL,
	`checkpoint_state_hash` text NOT NULL,
	`checkpoint_content_hash` text NOT NULL,
	`checkpoint_metadata_hash` text NOT NULL,
	`before_revision` integer,
	`before_state_vector` blob,
	`before_state_blob` blob,
	`before_content_hash` text,
	`before_metadata_json` text,
	`result_state_hash` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`error_message` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`action_id`, `entity_kind`, `entity_id`),
	FOREIGN KEY (`action_id`) REFERENCES `agent_user_checkpoint_action`(`id`) ON DELETE CASCADE,
	CHECK (`ordinal` >= 0),
	CHECK (`entity_kind` IN ('node', 'element', 'storyline', 'category')),
	CHECK (`status` IN ('pending', 'applied', 'compensated', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_user_checkpoint_action_entity_ordinal`
	ON `agent_user_checkpoint_action_entity` (`action_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `idx_agent_user_checkpoint_action_entity_status`
	ON `agent_user_checkpoint_action_entity` (`action_id`, `status`, `ordinal`);
