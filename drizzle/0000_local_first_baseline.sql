CREATE TABLE `agent_conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`sdk_session_id` text,
	`runtime_session_id` text,
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
CREATE INDEX `idx_agent_conversation_deleted_at` ON `agent_conversation` (`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_conversation_project_identity` ON `agent_conversation` (`id`,`project_id`);--> statement-breakpoint
CREATE TABLE `agent_mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`command` text,
	`args_json` text DEFAULT '[]' NOT NULL,
	`cwd` text,
	`public_env_json` text DEFAULT '{}' NOT NULL,
	`secret_env_json` text DEFAULT '{}' NOT NULL,
	`url` text,
	`public_headers_json` text DEFAULT '{}' NOT NULL,
	`secret_headers_json` text DEFAULT '{}' NOT NULL,
	`tool_policy_json` text DEFAULT '{}' NOT NULL,
	`config_revision` text NOT NULL,
	`health_status` text DEFAULT 'disabled' NOT NULL,
	`health_message` text DEFAULT '' NOT NULL,
	`server_info_json` text DEFAULT '{}' NOT NULL,
	`discovered_tools_json` text DEFAULT '[]' NOT NULL,
	`last_checked_at` text,
	`last_connected_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_mcp_server_project_name` ON `agent_mcp_server` (`project_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_mcp_server_scope_identity` ON `agent_mcp_server` (`id`,`project_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_mcp_server_project_enabled` ON `agent_mcp_server` (`project_id`,`enabled`);--> statement-breakpoint
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
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_memory_project` ON `agent_memory` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_memory_project_status` ON `agent_memory` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_memory_project_kind_status` ON `agent_memory` (`project_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_memory_target` ON `agent_memory` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `agent_permission_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text,
	`scope` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`provider_tool_name` text NOT NULL,
	`remote_tool_name` text NOT NULL,
	`access` text NOT NULL,
	`arguments_hash` text NOT NULL,
	`tool_definition_revision` text NOT NULL,
	`source_config_revision` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`revoked_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_permission_grant_match` ON `agent_permission_grant` (`project_id`,`source_kind`,`source_id`,`provider_tool_name`,`arguments_hash`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_permission_grant_project_status` ON `agent_permission_grant` (`project_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_permission_grant_session` ON `agent_permission_grant` (`session_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_permission_grant_active` ON `agent_permission_grant` (`project_id`,ifnull(`session_id`, ''),`scope`,`source_kind`,`source_id`,`provider_tool_name`,`remote_tool_name`,`access`,`arguments_hash`,`tool_definition_revision`,`source_config_revision`) WHERE "agent_permission_grant"."status" = 'active';--> statement-breakpoint
CREATE TABLE `agent_runtime_checkpoint` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`through_turn_ordinal` integer NOT NULL,
	`message_count` integer NOT NULL,
	`context_json` text NOT NULL,
	`context_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_runtime_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_checkpoint_session_turn` ON `agent_runtime_checkpoint` (`session_id`,`through_turn_ordinal`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_checkpoint_session_created` ON `agent_runtime_checkpoint` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_runtime_element_patch_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`effect_id` text NOT NULL,
	`command_id` text NOT NULL,
	`direction` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`patch_id` text NOT NULL,
	`expected_revision` text,
	`result_revision` text,
	`postimage_json` text,
	`postimage_hash` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`effect_id`) REFERENCES `agent_runtime_write_effect`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`,`project_id`) REFERENCES `agent_runtime_session`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_element_patch_receipt_command` ON `agent_runtime_element_patch_receipt` (`command_id`,`direction`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_element_patch_receipt_effect` ON `agent_runtime_element_patch_receipt` (`effect_id`,`direction`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_element_patch_receipt_patch` ON `agent_runtime_element_patch_receipt` (`project_id`,`patch_id`);--> statement-breakpoint
CREATE TABLE `agent_runtime_entity_write_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`effect_id` text NOT NULL,
	`command_id` text NOT NULL,
	`direction` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`expected_revision` text,
	`result_revision` text,
	`preimage_json` text,
	`preimage_hash` text,
	`postimage_json` text,
	`postimage_hash` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`effect_id`) REFERENCES `agent_runtime_write_effect`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`,`project_id`) REFERENCES `agent_runtime_session`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_entity_write_receipt_command` ON `agent_runtime_entity_write_receipt` (`command_id`,`direction`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_entity_write_receipt_effect` ON `agent_runtime_entity_write_receipt` (`effect_id`,`direction`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_entity_write_receipt_entity` ON `agent_runtime_entity_write_receipt` (`project_id`,`entity_kind`,`entity_id`);--> statement-breakpoint
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
	FOREIGN KEY (`session_id`) REFERENCES `agent_runtime_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `agent_runtime_turn`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_event_turn_seq` ON `agent_runtime_event` (`turn_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_event_session` ON `agent_runtime_event` (`session_id`);--> statement-breakpoint
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
	FOREIGN KEY (`session_id`) REFERENCES `agent_runtime_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `agent_runtime_turn`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_message_session_ordinal` ON `agent_runtime_message` (`session_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_message_turn_ordinal` ON `agent_runtime_message` (`turn_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `agent_runtime_read_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`revision` text NOT NULL,
	`state_vector` blob,
	`state_hash` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`receipt_id`,`project_id`,`session_id`,`turn_id`,`tool_call_id`) REFERENCES `agent_runtime_read_receipt`(`id`,`project_id`,`session_id`,`turn_id`,`tool_call_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_observation_ordinal` ON `agent_runtime_read_observation` (`receipt_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_observation_entity` ON `agent_runtime_read_observation` (`receipt_id`,`entity_kind`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_observation_provenance` ON `agent_runtime_read_observation` (`id`,`receipt_id`,`project_id`,`session_id`,`turn_id`,`tool_call_id`,`entity_kind`,`entity_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_read_observation_entity_revision` ON `agent_runtime_read_observation` (`project_id`,`entity_kind`,`entity_id`,`revision`);--> statement-breakpoint
CREATE TABLE `agent_runtime_read_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_access` text DEFAULT 'read' NOT NULL,
	`idempotency_key` text NOT NULL,
	`result_blob` blob NOT NULL,
	`result_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`,`project_id`) REFERENCES `agent_runtime_session`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`,`session_id`) REFERENCES `agent_runtime_turn`(`id`,`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`,`session_id`,`turn_id`,`call_id`,`idempotency_key`,`tool_access`,`tool_name`) REFERENCES `agent_runtime_tool_call`(`id`,`session_id`,`turn_id`,`call_id`,`idempotency_key`,`access`,`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_receipt_tool_call` ON `agent_runtime_read_receipt` (`tool_call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_receipt_idempotency` ON `agent_runtime_read_receipt` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_receipt_provenance` ON `agent_runtime_read_receipt` (`id`,`project_id`,`session_id`,`turn_id`,`tool_call_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_read_receipt_session_created` ON `agent_runtime_read_receipt` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_runtime_result_artifact` (
	`ref` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_access` text DEFAULT 'read' NOT NULL,
	`idempotency_key` text NOT NULL,
	`arguments_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`content_hash`) REFERENCES `agent_runtime_result_blob`(`content_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`,`project_id`) REFERENCES `agent_runtime_session`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`,`session_id`) REFERENCES `agent_runtime_turn`(`id`,`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`,`session_id`,`turn_id`,`call_id`,`idempotency_key`,`tool_access`,`tool_name`) REFERENCES `agent_runtime_tool_call`(`id`,`session_id`,`turn_id`,`call_id`,`idempotency_key`,`access`,`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_result_artifact_tool_call` ON `agent_runtime_result_artifact` (`tool_call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_result_artifact_provenance` ON `agent_runtime_result_artifact` (`ref`,`project_id`,`session_id`,`turn_id`,`tool_call_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_result_artifact_session_created` ON `agent_runtime_result_artifact` (`project_id`,`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_result_artifact_content` ON `agent_runtime_result_artifact` (`content_hash`);--> statement-breakpoint
CREATE TABLE `agent_runtime_result_blob` (
	`content_hash` text PRIMARY KEY NOT NULL,
	`content_blob` blob NOT NULL,
	`byte_count` integer NOT NULL,
	`char_count` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_result_blob_created` ON `agent_runtime_result_blob` (`created_at`);--> statement-breakpoint
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
	CONSTRAINT "agent_runtime_session_route_shape_check" CHECK(("agent_runtime_session"."route_kind" = 'chat'
	          and "agent_runtime_session"."conversation_id" is not null
	          and "agent_runtime_session"."goal_run_id" is null
	          and "agent_runtime_session"."chapter_id" is null)
	        or ("agent_runtime_session"."route_kind" = 'goal' and "agent_runtime_session"."conversation_id" is null)),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_project` ON `agent_runtime_session` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_conversation` ON `agent_runtime_session` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_goal` ON `agent_runtime_session` (`project_id`,`goal_run_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_recovery` ON `agent_runtime_session` (`project_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_session_project_identity` ON `agent_runtime_session` (`id`,`project_id`);--> statement-breakpoint
CREATE TABLE `agent_runtime_task_chapter_manifest` (
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`name` text NOT NULL,
	`resolved_chapter_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `ordinal`),
	FOREIGN KEY (`task_id`,`project_id`,`session_id`) REFERENCES `agent_runtime_task`(`id`,`project_id`,`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_manifest_chapter` ON `agent_runtime_task_chapter_manifest` (`task_id`,`resolved_chapter_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_task_manifest_scope` ON `agent_runtime_task_chapter_manifest` (`project_id`,`session_id`,`task_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `agent_runtime_task_command` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_access` text DEFAULT 'write' NOT NULL,
	`task_id` text NOT NULL,
	`arguments_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`,`project_id`,`session_id`) REFERENCES `agent_runtime_task`(`id`,`project_id`,`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`,`session_id`) REFERENCES `agent_runtime_turn`(`id`,`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`,`session_id`,`turn_id`,`call_id`,`idempotency_key`,`tool_access`,`tool_name`) REFERENCES `agent_runtime_tool_call`(`id`,`session_id`,`turn_id`,`call_id`,`idempotency_key`,`access`,`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_command_call` ON `agent_runtime_task_command` (`turn_id`,`call_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_task_command_task` ON `agent_runtime_task_command` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_runtime_task_constraint` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`body` text NOT NULL,
	`source` text DEFAULT 'agent' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`superseded_by_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`settled_at` text,
	FOREIGN KEY (`task_id`,`project_id`,`session_id`) REFERENCES `agent_runtime_task`(`id`,`project_id`,`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_constraint_scope_identity` ON `agent_runtime_task_constraint` (`id`,`task_id`,`project_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_task_constraint_status` ON `agent_runtime_task_constraint` (`task_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_runtime_task_step` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`work_kind` text DEFAULT 'edit' NOT NULL,
	`target_kind` text,
	`target_name` text,
	`resolved_target_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_note` text,
	`result_ref` text,
	`review_result_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`task_id`,`project_id`,`session_id`) REFERENCES `agent_runtime_task`(`id`,`project_id`,`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_step_ordinal` ON `agent_runtime_task_step` (`task_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_step_scope_identity` ON `agent_runtime_task_step` (`id`,`task_id`,`project_id`,`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_step_in_progress` ON `agent_runtime_task_step` (`task_id`) WHERE "agent_runtime_task_step"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_task_step_status` ON `agent_runtime_task_step` (`task_id`,`status`,`ordinal`);--> statement-breakpoint
CREATE TABLE `agent_runtime_task` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`objective` text NOT NULL,
	`scope_kind` text DEFAULT 'explicit_targets' NOT NULL,
	`work_kind` text DEFAULT 'edit' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`session_id`,`project_id`) REFERENCES `agent_runtime_session`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_scope_identity` ON `agent_runtime_task` (`id`,`project_id`,`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_open_session` ON `agent_runtime_task` (`project_id`,`session_id`) WHERE "agent_runtime_task"."status" IN ('active', 'paused', 'blocked');--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_task_scope_status` ON `agent_runtime_task` (`project_id`,`session_id`,`status`,`updated_at`);--> statement-breakpoint
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
	FOREIGN KEY (`session_id`) REFERENCES `agent_runtime_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`) REFERENCES `agent_runtime_turn`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_tool_call_turn_call` ON `agent_runtime_tool_call` (`turn_id`,`call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_tool_call_idempotency` ON `agent_runtime_tool_call` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_tool_call_write_provenance` ON `agent_runtime_tool_call` (`id`,`session_id`,`turn_id`,`call_id`,`idempotency_key`,`access`,`name`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_tool_call_turn_status` ON `agent_runtime_tool_call` (`turn_id`,`status`);--> statement-breakpoint
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
	FOREIGN KEY (`session_id`) REFERENCES `agent_runtime_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_turn_session_ordinal` ON `agent_runtime_turn` (`session_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_turn_session_identity` ON `agent_runtime_turn` (`id`,`session_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_turn_session_status` ON `agent_runtime_turn` (`session_id`,`status`);--> statement-breakpoint
CREATE TABLE `agent_runtime_write_effect` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`route_kind` text NOT NULL,
	`conversation_id` text,
	`goal_run_id` text,
	`chapter_id` text,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_access` text DEFAULT 'write' NOT NULL,
	`idempotency_key` text NOT NULL,
	`authorization_kind` text,
	`authorization_request_id` text,
	`authorization_arguments_hash` text,
	`authorized_at` text,
	`phase` text DEFAULT 'claimed' NOT NULL,
	`arguments_json` text NOT NULL,
	`expected_revision_json` text,
	`observed_revision_json` text,
	`preimage_json` text,
	`forward_json` text,
	`inverse_json` text,
	`reversibility` text,
	`effect_json` text,
	`result_json` text,
	`error_code` text,
	`error_message` text,
	`claimed_at` text NOT NULL,
	`confirmed_at` text,
	`mutation_started_at` text,
	`effect_committed_at` text,
	`result_committed_at` text,
	`uncertain_at` text,
	`failed_at` text,
	`declined_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`,`project_id`) REFERENCES `agent_runtime_session`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`turn_id`,`session_id`) REFERENCES `agent_runtime_turn`(`id`,`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`,`session_id`,`turn_id`,`call_id`,`idempotency_key`,`tool_access`,`tool_name`) REFERENCES `agent_runtime_tool_call`(`id`,`session_id`,`turn_id`,`call_id`,`idempotency_key`,`access`,`name`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`,`project_id`) REFERENCES `agent_conversation`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_effect_tool_call` ON `agent_runtime_write_effect` (`tool_call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_effect_idempotency` ON `agent_runtime_write_effect` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_effect_turn_call` ON `agent_runtime_write_effect` (`turn_id`,`call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_effect_provenance` ON `agent_runtime_write_effect` (`id`,`session_id`,`turn_id`,`tool_call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_effect_freshness_provenance` ON `agent_runtime_write_effect` (`id`,`project_id`,`session_id`,`turn_id`,`tool_call_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_write_effect_session_phase` ON `agent_runtime_write_effect` (`session_id`,`phase`);--> statement-breakpoint
CREATE TABLE `agent_runtime_write_expectation` (
	`id` text PRIMARY KEY NOT NULL,
	`effect_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`write_turn_id` text NOT NULL,
	`write_tool_call_id` text NOT NULL,
	`observation_id` text NOT NULL,
	`read_receipt_id` text NOT NULL,
	`read_turn_id` text NOT NULL,
	`read_tool_call_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`expected_revision` text NOT NULL,
	`expected_state_vector` blob,
	`expected_state_hash` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`effect_id`,`project_id`,`session_id`,`write_turn_id`,`write_tool_call_id`) REFERENCES `agent_runtime_write_effect`(`id`,`project_id`,`session_id`,`turn_id`,`tool_call_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`observation_id`,`read_receipt_id`,`project_id`,`session_id`,`read_turn_id`,`read_tool_call_id`,`entity_kind`,`entity_id`,`expected_revision`) REFERENCES `agent_runtime_read_observation`(`id`,`receipt_id`,`project_id`,`session_id`,`turn_id`,`tool_call_id`,`entity_kind`,`entity_id`,`revision`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_expectation_observation` ON `agent_runtime_write_expectation` (`effect_id`,`observation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_expectation_entity` ON `agent_runtime_write_expectation` (`effect_id`,`entity_kind`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_write_expectation_effect` ON `agent_runtime_write_expectation` (`effect_id`);--> statement-breakpoint
CREATE TABLE `agent_runtime_write_review_block` (
	`review_id` text NOT NULL,
	`effect_id` text NOT NULL,
	`block_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_note_json` text,
	`revert_effect_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`revert_started_at` text,
	`settled_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`review_id`, `block_id`),
	FOREIGN KEY (`review_id`,`effect_id`) REFERENCES `agent_runtime_write_review`(`id`,`effect_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_review_block_ordinal` ON `agent_runtime_write_review_block` (`review_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_write_review_block_status` ON `agent_runtime_write_review_block` (`review_id`,`status`);--> statement-breakpoint
CREATE TABLE `agent_runtime_write_review` (
	`id` text PRIMARY KEY NOT NULL,
	`effect_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_note_json` text,
	`revert_effect_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`accepted_at` text,
	`rejected_at` text,
	`revert_started_at` text,
	`settled_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`effect_id`,`session_id`,`turn_id`,`tool_call_id`) REFERENCES `agent_runtime_write_effect`(`id`,`session_id`,`turn_id`,`tool_call_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_review_effect` ON `agent_runtime_write_review` (`effect_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_review_provenance` ON `agent_runtime_write_review` (`id`,`effect_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_write_review_session_status` ON `agent_runtime_write_review` (`session_id`,`status`);--> statement-breakpoint
CREATE TABLE `agent_working_memory` (
	`project_id` text PRIMARY KEY NOT NULL,
	`content_md` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`approx_tokens` integer DEFAULT 0 NOT NULL,
	`updated_by` text DEFAULT 'agent' NOT NULL,
	`last_compacted_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_working_memory_revision_nonnegative" CHECK("agent_working_memory"."revision" >= 0),
	CONSTRAINT "agent_working_memory_tokens_nonnegative" CHECK("agent_working_memory"."approx_tokens" >= 0),
	CONSTRAINT "agent_working_memory_updated_by" CHECK("agent_working_memory"."updated_by" in ('author', 'agent'))
);
--> statement-breakpoint
CREATE TABLE `block_section` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`chapter_id` text NOT NULL,
	`block_ids_json` text NOT NULL,
	`block_hashes_json` text DEFAULT '{}' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'copilot-rolling' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_block_section_project` ON `block_section` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_block_section_chapter` ON `block_section` (`chapter_id`);--> statement-breakpoint
CREATE TABLE `book_act` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`start_order` real,
	`drift_node_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`drift_node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_book_act_project` ON `book_act` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_book_act_drift` ON `book_act` (`drift_node_id`);--> statement-breakpoint
CREATE TABLE `element` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category_id` text,
	`name` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`content_json` text DEFAULT '{}' NOT NULL,
	`kv_json` text DEFAULT '[]' NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`group_name` text,
	`portrait_asset_id` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `element_category`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`portrait_asset_id`) REFERENCES `project_asset`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_element_deleted_at` ON `element` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_element_category` ON `element` (`category_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_element_portrait_asset` ON `element` (`portrait_asset_id`);--> statement-breakpoint
CREATE TABLE `book_node` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`book_order` integer,
	`narrative_order` integer,
	`project_id` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`word_count_basis_kind` text,
	`word_count_basis_hash` text,
	`word_count_basis_revision` integer,
	`word_count_basis_server_seq` integer,
	`writing_status` text DEFAULT 'draft' NOT NULL,
	`kind` text DEFAULT 'drift' NOT NULL,
	`drift_group_id` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`position_x` real NOT NULL,
	`position_y` real NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_book_node_project` ON `book_node` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_book_node_project_book_order` ON `book_node` (`project_id`,`book_order`);--> statement-breakpoint
CREATE INDEX `idx_book_node_project_narrative_order` ON `book_node` (`project_id`,`narrative_order`);--> statement-breakpoint
CREATE INDEX `idx_book_node_project_kind` ON `book_node` (`project_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_book_node_drift_group` ON `book_node` (`drift_group_id`);--> statement-breakpoint
CREATE INDEX `idx_book_node_deleted_at` ON `book_node` (`deleted_at`);--> statement-breakpoint
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
	FOREIGN KEY (`comment_id`) REFERENCES `comment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_comment_action_comment` ON `comment_action` (`comment_id`);--> statement-breakpoint
CREATE INDEX `idx_comment_action_project` ON `comment_action` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_comment_action_status` ON `comment_action` (`status`);--> statement-breakpoint
CREATE TABLE `comment` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text DEFAULT 'note' NOT NULL,
	`target_kind` text,
	`target_id` text,
	`target_block_id` text,
	`anchor_json` text DEFAULT '{}' NOT NULL,
	`author_kind` text DEFAULT 'user' NOT NULL,
	`author_id` text,
	`author_name` text,
	`body_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`metadata_json` text,
	`target_block_ids_json` text DEFAULT '[]' NOT NULL,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_comment_project` ON `comment` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_comment_target` ON `comment` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_comment_block` ON `comment` (`target_kind`,`target_id`,`target_block_id`);--> statement-breakpoint
CREATE INDEX `idx_comment_project_status` ON `comment` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_comment_project_kind_status` ON `comment` (`project_id`,`kind`,`status`);--> statement-breakpoint
CREATE TABLE `drift_group` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`parent_group_id` text,
	`color` text,
	`sort_order` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_drift_group_project` ON `drift_group` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_drift_group_parent` ON `drift_group` (`parent_group_id`);--> statement-breakpoint
CREATE TABLE `element_category` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`content_json` text DEFAULT '{}',
	`element_template_json` text DEFAULT '{}',
	`element_template_kv_json` text DEFAULT '[]' NOT NULL,
	`color` text NOT NULL,
	`project_id` text NOT NULL,
	`layout_mode` text DEFAULT 'auto' NOT NULL,
	`grid_x` integer,
	`grid_y` integer,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_element_category_project` ON `element_category` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_element_category_deleted_at` ON `element_category` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `element_patch` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`element_id` text NOT NULL,
	`source_node_id` text,
	`source_block_id` text,
	`source_block_text` text,
	`text_anchor_json` text,
	`invalidated_at` text,
	`title` text,
	`content_json` text DEFAULT '{}' NOT NULL,
	`order_key` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`element_id`) REFERENCES `element`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_patch_element` ON `element_patch` (`element_id`);--> statement-breakpoint
CREATE INDEX `idx_patch_source_node` ON `element_patch` (`source_node_id`);--> statement-breakpoint
CREATE INDEX `idx_patch_project` ON `element_patch` (`project_id`);--> statement-breakpoint
CREATE TABLE `entity_relation` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_kind` text NOT NULL,
	`from_id` text NOT NULL,
	`to_kind` text NOT NULL,
	`to_id` text NOT NULL,
	`relation_type_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`relation_type_id`,`project_id`) REFERENCES `entity_relation_type`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entity_relation_endpoint_kinds" CHECK("entity_relation"."from_kind" in ('node', 'element', 'patch', 'category', 'storyline', 'comment', 'library_item') and "entity_relation"."to_kind" in ('node', 'element', 'patch', 'category', 'storyline'))
);
--> statement-breakpoint
CREATE INDEX `idx_relation_from` ON `entity_relation` (`from_kind`,`from_id`);--> statement-breakpoint
CREATE INDEX `idx_relation_to` ON `entity_relation` (`to_kind`,`to_id`);--> statement-breakpoint
CREATE INDEX `idx_relation_project` ON `entity_relation` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_relation_type` ON `entity_relation` (`relation_type_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_entity_relation_semantic_edge` ON `entity_relation` (`project_id`,`from_kind`,`from_id`,`to_kind`,`to_id`,`relation_type_id`);--> statement-breakpoint
CREATE TABLE `entity_relation_type_endpoint_kind` (
	`relation_type_id` text NOT NULL,
	`side` text NOT NULL,
	`entity_kind` text NOT NULL,
	PRIMARY KEY(`relation_type_id`, `side`, `entity_kind`),
	FOREIGN KEY (`relation_type_id`) REFERENCES `entity_relation_type`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "relation_type_endpoint_side" CHECK("entity_relation_type_endpoint_kind"."side" in ('source', 'target')),
	CONSTRAINT "relation_type_endpoint_kind" CHECK(("entity_relation_type_endpoint_kind"."side" = 'source' and "entity_relation_type_endpoint_kind"."entity_kind" in ('node', 'element', 'patch', 'category', 'storyline', 'comment', 'library_item')) or ("entity_relation_type_endpoint_kind"."side" = 'target' and "entity_relation_type_endpoint_kind"."entity_kind" in ('node', 'element', 'patch', 'category', 'storyline')))
);
--> statement-breakpoint
CREATE TABLE `entity_relation_type` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`orientation` text NOT NULL,
	`system_key` text,
	`locked` integer DEFAULT false NOT NULL,
	`source_role` text DEFAULT '' NOT NULL,
	`target_role` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "relation_type_orientation" CHECK("entity_relation_type"."orientation" in ('directed', 'symmetric')),
	CONSTRAINT "relation_type_system_key" CHECK("entity_relation_type"."system_key" is null or "entity_relation_type"."system_key" = 'generic-association'),
	CONSTRAINT "relation_type_system_lock" CHECK(("entity_relation_type"."system_key" is null and "entity_relation_type"."locked" = 0) or ("entity_relation_type"."system_key" is not null and "entity_relation_type"."locked" = 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_relation_type_project_name` ON `entity_relation_type` (`project_id`,`normalized_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_relation_type_project_system_key` ON `entity_relation_type` (`project_id`,`system_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_relation_type_project_identity` ON `entity_relation_type` (`id`,`project_id`);--> statement-breakpoint
CREATE INDEX `idx_relation_type_project` ON `entity_relation_type` (`project_id`);--> statement-breakpoint
CREATE TABLE `entity_snapshot_history` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`state_blob` blob NOT NULL,
	`content_json` text,
	`meta_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entity_snapshot_entity` ON `entity_snapshot_history` (`entity_kind`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_entity_snapshot_project` ON `entity_snapshot_history` (`project_id`);--> statement-breakpoint
CREATE TABLE `inline_mention` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_kind` text NOT NULL,
	`from_id` text NOT NULL,
	`from_block_id` text NOT NULL,
	`from_spans_json` text NOT NULL,
	`to_kind` text NOT NULL,
	`to_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mention_from` ON `inline_mention` (`from_kind`,`from_id`);--> statement-breakpoint
CREATE INDEX `idx_mention_to` ON `inline_mention` (`to_kind`,`to_id`);--> statement-breakpoint
CREATE INDEX `idx_mention_project` ON `inline_mention` (`project_id`);--> statement-breakpoint
CREATE TABLE `library_item` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`asset_id` text,
	`external_url` text,
	`body_json` text,
	`notes_json` text,
	`preview_image_url` text,
	`order_key` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `project_asset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "library_item_kind_check" CHECK("library_item"."kind" in ('image', 'pdf', 'url', 'text')),
	CONSTRAINT "library_item_payload_check" CHECK((
        "library_item"."kind" in ('image', 'pdf')
        and "library_item"."asset_id" is not null
        and "library_item"."external_url" is null
        and "library_item"."body_json" is null
        and "library_item"."preview_image_url" is null
      ) or (
        "library_item"."kind" = 'url'
        and "library_item"."asset_id" is null
        and "library_item"."external_url" is not null
        and length(trim("library_item"."external_url")) > 0
        and "library_item"."body_json" is null
      ) or (
        "library_item"."kind" = 'text'
        and "library_item"."asset_id" is null
        and "library_item"."external_url" is null
        and "library_item"."preview_image_url" is null
      )),
	CONSTRAINT "library_item_body_json_check" CHECK("library_item"."body_json" is null or (json_valid("library_item"."body_json") and json_extract("library_item"."body_json", '$.type') = 'doc')),
	CONSTRAINT "library_item_notes_json_check" CHECK("library_item"."notes_json" is null or (json_valid("library_item"."notes_json") and json_extract("library_item"."notes_json", '$.type') = 'doc'))
);
--> statement-breakpoint
CREATE INDEX `idx_library_item_project` ON `library_item` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_library_item_project_kind` ON `library_item` (`project_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_library_item_asset` ON `library_item` (`asset_id`);--> statement-breakpoint
CREATE TABLE `node_content` (
	`node_id` text PRIMARY KEY NOT NULL,
	`content_json` text DEFAULT '{}',
	`outline_json` text DEFAULT '[]',
	`plot_grid_json` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_node_content_node` ON `node_content` (`node_id`);--> statement-breakpoint
CREATE TABLE `plot_grid_document` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`cell_width` real DEFAULT 184 NOT NULL,
	`cell_height` real DEFAULT 96 NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plot_grid_document_size_check" CHECK("plot_grid_document"."cell_width" between 120 and 440 and "plot_grid_document"."cell_height" between 56 and 380)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_plot_grid_document_node` ON `plot_grid_document` (`node_id`);--> statement-breakpoint
CREATE TABLE `plot_grid_row` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`position_key` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `plot_grid_document`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plot_grid_row_position_key_check" CHECK(length("plot_grid_row"."position_key") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_plot_grid_row_document_identity` ON `plot_grid_row` (`id`,`document_id`);--> statement-breakpoint
CREATE INDEX `idx_plot_grid_row_order` ON `plot_grid_row` (`document_id`,`position_key`,`id`);--> statement-breakpoint
CREATE TABLE `plot_grid_column` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`position_key` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `plot_grid_document`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plot_grid_column_position_key_check" CHECK(length("plot_grid_column"."position_key") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_plot_grid_column_document_identity` ON `plot_grid_column` (`id`,`document_id`);--> statement-breakpoint
CREATE INDEX `idx_plot_grid_column_order` ON `plot_grid_column` (`document_id`,`position_key`,`id`);--> statement-breakpoint
CREATE TABLE `plot_grid_cell` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`row_id` text NOT NULL,
	`column_id` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `plot_grid_document`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `fk_plot_grid_cell_row_document` FOREIGN KEY (`row_id`,`document_id`) REFERENCES `plot_grid_row`(`id`,`document_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `fk_plot_grid_cell_column_document` FOREIGN KEY (`column_id`,`document_id`) REFERENCES `plot_grid_column`(`id`,`document_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_plot_grid_cell_coordinate` ON `plot_grid_cell` (`document_id`,`row_id`,`column_id`);--> statement-breakpoint
CREATE INDEX `idx_plot_grid_cell_row` ON `plot_grid_cell` (`document_id`,`row_id`);--> statement-breakpoint
CREATE INDEX `idx_plot_grid_cell_column` ON `plot_grid_cell` (`document_id`,`column_id`);--> statement-breakpoint
CREATE TABLE `node_storyline_link` (
	`node_id` text NOT NULL,
	`storyline_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`node_id`, `storyline_id`),
	FOREIGN KEY (`node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`storyline_id`) REFERENCES `storylines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_node_storyline_node` ON `node_storyline_link` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_node_storyline_storyline` ON `node_storyline_link` (`storyline_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_node_primary_storyline` ON `node_storyline_link` (`node_id`) WHERE "node_storyline_link"."is_primary" = 1;--> statement-breakpoint
CREATE TABLE `project_asset` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_mime` text NOT NULL,
	`source_size_bytes` integer NOT NULL,
	`source_sha256` text NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_asset_kind_check" CHECK("project_asset"."kind" in ('image', 'pdf')),
	CONSTRAINT "project_asset_source_size_check" CHECK("project_asset"."source_size_bytes" > 0),
	CONSTRAINT "project_asset_sha256_check" CHECK(length("project_asset"."source_sha256") = 64 and "project_asset"."source_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "project_asset_shape_check" CHECK((
        "project_asset"."kind" = 'image'
        and "project_asset"."source_mime" like 'image/%'
        and "project_asset"."width" > 0
        and "project_asset"."height" > 0
      ) or (
        "project_asset"."kind" = 'pdf'
        and "project_asset"."source_mime" = 'application/pdf'
        and "project_asset"."width" is null
        and "project_asset"."height" is null
      ))
);
--> statement-breakpoint
CREATE INDEX `idx_project_asset_project` ON `project_asset` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_asset_project_sha256` ON `project_asset` (`project_id`,`source_sha256`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`kv_json` text DEFAULT '[]' NOT NULL,
	`storyline_template_kv_json` text DEFAULT '[]' NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entity_kv_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entity_kv_entry_owner_namespace_check" CHECK((`entity_kv_entry`.`owner_kind` = 'project' and `entity_kv_entry`.`namespace` in ('facts', 'storyline-template'))
        or (`entity_kv_entry`.`owner_kind` = 'storyline' and `entity_kv_entry`.`namespace` = 'facts')
        or (`entity_kv_entry`.`owner_kind` = 'element-category' and `entity_kv_entry`.`namespace` = 'element-template')
        or (`entity_kv_entry`.`owner_kind` = 'element' and `entity_kv_entry`.`namespace` = 'facts')),
	CONSTRAINT "entity_kv_entry_identity_check" CHECK(length(`entity_kv_entry`.`owner_id`) > 0 and length(`entity_kv_entry`.`id`) > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_entity_kv_entry_project` ON `entity_kv_entry` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_entity_kv_entry_owner` ON `entity_kv_entry` (`project_id`,`owner_kind`,`owner_id`,`namespace`);--> statement-breakpoint
CREATE TABLE `storylines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`order_key` integer NOT NULL,
	`content_json` text DEFAULT '{}' NOT NULL,
	`kv_json` text DEFAULT '[]' NOT NULL,
	`node_content_template_json` text DEFAULT '{}' NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_storyline_deleted_at` ON `storylines` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `sync_app_authority` (
	`id` text PRIMARY KEY DEFAULT 'app' NOT NULL,
	`mode` text DEFAULT 'local' NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`transition_state` text DEFAULT 'stable' NOT NULL,
	`target_mode` text,
	`attempt_id` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "sync_app_authority_singleton_check" CHECK("sync_app_authority"."id" = 'app'),
	CONSTRAINT "sync_app_authority_mode_check" CHECK("sync_app_authority"."mode" in ('local', 'google-drive', 'hosted')),
	CONSTRAINT "sync_app_authority_generation_check" CHECK("sync_app_authority"."generation" >= 1),
	CONSTRAINT "sync_app_authority_transition_check" CHECK((
        "sync_app_authority"."transition_state" = 'stable'
        and "sync_app_authority"."target_mode" is null
        and "sync_app_authority"."attempt_id" is null
      ) or (
        "sync_app_authority"."transition_state" = 'connecting'
        and "sync_app_authority"."mode" = 'local'
        and "sync_app_authority"."target_mode" in ('google-drive', 'hosted')
        and "sync_app_authority"."attempt_id" is not null
      ) or (
        "sync_app_authority"."transition_state" = 'switching'
        and "sync_app_authority"."mode" in ('google-drive', 'hosted')
        and "sync_app_authority"."target_mode" in ('google-drive', 'hosted')
        and "sync_app_authority"."target_mode" <> "sync_app_authority"."mode"
        and "sync_app_authority"."attempt_id" is not null
      ) or (
        "sync_app_authority"."transition_state" = 'disconnecting'
        and "sync_app_authority"."mode" in ('google-drive', 'hosted')
        and "sync_app_authority"."target_mode" = 'local'
        and "sync_app_authority"."attempt_id" is not null
      ) or (
        "sync_app_authority"."transition_state" = 'blocked'
        and "sync_app_authority"."target_mode" in ('local', 'google-drive', 'hosted')
        and "sync_app_authority"."target_mode" <> "sync_app_authority"."mode"
        and "sync_app_authority"."attempt_id" is not null
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_app_authority_identity` ON `sync_app_authority` (`id`,`mode`,`generation`);--> statement-breakpoint
CREATE TABLE `sync_apply_receipt` (
	`change_set_id` text PRIMARY KEY NOT NULL,
	`sync_generation_id` text NOT NULL,
	`mutation_count` integer NOT NULL,
	`source_object_id` text,
	`state_sha256` text,
	`applied_at` text NOT NULL,
	FOREIGN KEY (`change_set_id`,`sync_generation_id`) REFERENCES `sync_change_set`(`change_set_id`,`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_apply_receipt_mutation_count_check" CHECK("sync_apply_receipt"."mutation_count" > 0),
	CONSTRAINT "sync_apply_receipt_state_hash_check" CHECK("sync_apply_receipt"."state_sha256" is null or (
        length("sync_apply_receipt"."state_sha256") = 64 and "sync_apply_receipt"."state_sha256" not glob '*[^0-9a-f]*'
      ))
);
--> statement-breakpoint
CREATE INDEX `idx_sync_apply_receipt_generation` ON `sync_apply_receipt` (`sync_generation_id`,`applied_at`);--> statement-breakpoint
CREATE TABLE `sync_blob_state` (
	`sync_generation_id` text NOT NULL,
	`blob_id` text NOT NULL,
	`asset_id` text,
	`logical_key_id` text NOT NULL,
	`content_sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`mime` text NOT NULL,
	`local_object_id` text,
	`local_state` text DEFAULT 'missing' NOT NULL,
	`remote_state` text DEFAULT 'missing' NOT NULL,
	`verified_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`sync_generation_id`, `blob_id`),
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`local_object_id`) REFERENCES `sync_local_object`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_blob_hash_check" CHECK(length("sync_blob_state"."content_sha256") = 64 and "sync_blob_state"."content_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "sync_blob_size_check" CHECK("sync_blob_state"."size_bytes" >= 0),
	CONSTRAINT "sync_blob_local_state_check" CHECK("sync_blob_state"."local_state" in ('missing', 'staged', 'verified', 'corrupt')),
	CONSTRAINT "sync_blob_remote_state_check" CHECK("sync_blob_state"."remote_state" in ('missing', 'publishing', 'available', 'removed', 'corrupt'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_blob_logical_key` ON `sync_blob_state` (`sync_generation_id`,`logical_key_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_blob_delivery` ON `sync_blob_state` (`sync_generation_id`,`local_state`,`remote_state`);--> statement-breakpoint
CREATE TABLE `sync_change_set` (
	`change_set_id` text PRIMARY KEY NOT NULL,
	`sync_generation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`project_sync_id` text NOT NULL,
	`writer_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`device_seq` integer NOT NULL,
	`hlc_wall_ms` integer NOT NULL,
	`hlc_counter` integer NOT NULL,
	`protocol_version` integer DEFAULT 1 NOT NULL,
	`payload_version` integer DEFAULT 1 NOT NULL,
	`mutation_count` integer NOT NULL,
	`encoded_bytes` blob NOT NULL,
	`payload_sha256` text NOT NULL,
	`origin` text NOT NULL,
	`apply_state` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`applied_at` text,
	FOREIGN KEY (`sync_generation_id`,`project_sync_id`) REFERENCES `sync_generation`(`sync_generation_id`,`project_sync_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_change_set_sequence_check" CHECK("sync_change_set"."device_seq" >= 1 and "sync_change_set"."hlc_wall_ms" >= 0 and "sync_change_set"."hlc_counter" >= 0),
	CONSTRAINT "sync_change_set_version_check" CHECK("sync_change_set"."protocol_version" = 1 and "sync_change_set"."payload_version" = 1),
	CONSTRAINT "sync_change_set_mutation_count_check" CHECK("sync_change_set"."mutation_count" > 0),
	CONSTRAINT "sync_change_set_hash_check" CHECK(length("sync_change_set"."payload_sha256") = 64 and "sync_change_set"."payload_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "sync_change_set_origin_check" CHECK("sync_change_set"."origin" in ('local', 'remote')),
	CONSTRAINT "sync_change_set_apply_state_check" CHECK("sync_change_set"."apply_state" in ('pending', 'applying', 'applied', 'quarantined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_change_set_writer_sequence` ON `sync_change_set` (`sync_generation_id`,`writer_id`,`writer_epoch`,`device_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_change_set_identity_generation` ON `sync_change_set` (`change_set_id`,`sync_generation_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_change_set_apply_state` ON `sync_change_set` (`sync_generation_id`,`apply_state`,`created_at`);--> statement-breakpoint
CREATE TABLE `sync_checkpoint` (
	`checkpoint_id` text PRIMARY KEY NOT NULL,
	`sync_generation_id` text NOT NULL,
	`kind` text NOT NULL,
	`protocol_version` integer DEFAULT 1 NOT NULL,
	`domain_schema_version` integer NOT NULL,
	`frontier_cbor` blob NOT NULL,
	`local_object_id` text NOT NULL,
	`logical_key_id` text NOT NULL,
	`content_sha256` text NOT NULL,
	`state` text DEFAULT 'captured' NOT NULL,
	`change_set_count` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	`published_at` text,
	`verified_at` text,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`local_object_id`) REFERENCES `sync_local_object`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_checkpoint_kind_check" CHECK("sync_checkpoint"."kind" in ('genesis', 'checkpoint')),
	CONSTRAINT "sync_checkpoint_version_check" CHECK("sync_checkpoint"."protocol_version" = 1 and "sync_checkpoint"."domain_schema_version" >= 1),
	CONSTRAINT "sync_checkpoint_size_check" CHECK("sync_checkpoint"."change_set_count" >= 0 and "sync_checkpoint"."size_bytes" >= 0),
	CONSTRAINT "sync_checkpoint_hash_check" CHECK(length("sync_checkpoint"."content_sha256") = 64 and "sync_checkpoint"."content_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "sync_checkpoint_state_check" CHECK("sync_checkpoint"."state" in ('captured', 'publishing', 'published', 'verified', 'quarantined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_checkpoint_logical_key` ON `sync_checkpoint` (`sync_generation_id`,`logical_key_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_checkpoint_state` ON `sync_checkpoint` (`sync_generation_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `sync_conflict` (
	`conflict_id` text PRIMARY KEY NOT NULL,
	`sync_generation_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_kind` text,
	`target_id` text,
	`incarnation` integer,
	`change_set_id` text,
	`mutation_index` integer,
	`details_cbor` blob NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`resolution_cbor` blob,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`change_set_id`) REFERENCES `sync_change_set`(`change_set_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_conflict_kind_check" CHECK("sync_conflict"."kind" in ('semantic', 'invariant', 'object-collision', 'writer-fork')),
	CONSTRAINT "sync_conflict_mutation_pair_check" CHECK(("sync_conflict"."change_set_id" is null and "sync_conflict"."mutation_index" is null)
        or ("sync_conflict"."change_set_id" is not null and "sync_conflict"."mutation_index" >= 0)),
	CONSTRAINT "sync_conflict_state_check" CHECK(("sync_conflict"."state" = 'open' and "sync_conflict"."resolved_at" is null)
        or ("sync_conflict"."state" in ('resolved', 'dismissed') and "sync_conflict"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_sync_conflict_open` ON `sync_conflict` (`sync_generation_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `sync_connect_attempt` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`authority_generation` integer NOT NULL,
	`kind` text NOT NULL,
	`target_mode` text NOT NULL,
	`target_account_subject_id` text,
	`target_credential_secret_ref` text,
	`state` text DEFAULT 'preparing' NOT NULL,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "sync_connect_generation_check" CHECK("sync_connect_attempt"."authority_generation" >= 1),
	CONSTRAINT "sync_connect_kind_check" CHECK("sync_connect_attempt"."kind" in ('connect', 'switch-provider', 'disconnect', 'restore')),
	CONSTRAINT "sync_connect_target_mode_check" CHECK("sync_connect_attempt"."target_mode" in ('local', 'google-drive', 'hosted')),
	CONSTRAINT "sync_connect_target_account_check" CHECK(("sync_connect_attempt"."target_mode" = 'local'
          and "sync_connect_attempt"."target_account_subject_id" is null
          and "sync_connect_attempt"."target_credential_secret_ref" is null)
        or ("sync_connect_attempt"."target_mode" in ('google-drive', 'hosted')
          and "sync_connect_attempt"."target_account_subject_id" is not null
          and "sync_connect_attempt"."target_credential_secret_ref" is not null)),
	CONSTRAINT "sync_connect_kind_target_check" CHECK(("sync_connect_attempt"."kind" = 'disconnect' and "sync_connect_attempt"."target_mode" = 'local')
        or ("sync_connect_attempt"."kind" in ('connect', 'switch-provider', 'restore')
          and "sync_connect_attempt"."target_mode" in ('google-drive', 'hosted'))),
	CONSTRAINT "sync_connect_state_check" CHECK("sync_connect_attempt"."state" in (
		'preparing', 'discovering', 'publishing-genesis', 'restoring',
		'activating', 'completed',
		'blocked', 'failed', 'cancelled'
	)),
	CONSTRAINT "sync_connect_completion_check" CHECK(("sync_connect_attempt"."state" in ('completed', 'failed', 'cancelled')
          and "sync_connect_attempt"."completed_at" is not null)
        or ("sync_connect_attempt"."state" not in ('completed', 'failed', 'cancelled')
          and "sync_connect_attempt"."completed_at" is null))
);
--> statement-breakpoint
CREATE INDEX `idx_sync_connect_attempt_state` ON `sync_connect_attempt` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `sync_connect_generation_attempt` (
	`attempt_id` text NOT NULL,
	`source_sync_generation_id` text NOT NULL,
	`target_sync_generation_id` text,
	`source_checkpoint_id` text,
	`commit_marker_object_id` text,
	`activation_receipt` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`activated_at` text,
	PRIMARY KEY(`attempt_id`, `source_sync_generation_id`),
	FOREIGN KEY (`attempt_id`) REFERENCES `sync_connect_attempt`(`attempt_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_checkpoint_id`) REFERENCES `sync_checkpoint`(`checkpoint_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`commit_marker_object_id`) REFERENCES `sync_remote_object`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_connect_generation_target_check" CHECK("sync_connect_generation_attempt"."target_sync_generation_id" is null or "sync_connect_generation_attempt"."target_sync_generation_id" <> "sync_connect_generation_attempt"."source_sync_generation_id"),
	CONSTRAINT "sync_connect_generation_state_check" CHECK("sync_connect_generation_attempt"."state" in (
        'pending', 'capturing', 'publishing', 'restoring', 'committed',
        'activating', 'activated', 'failed', 'cancelled'
      )),
	CONSTRAINT "sync_connect_generation_activation_check" CHECK(("sync_connect_generation_attempt"."state" = 'activated'
          and "sync_connect_generation_attempt"."activation_receipt" is not null
          and "sync_connect_generation_attempt"."activated_at" is not null)
        or ("sync_connect_generation_attempt"."state" <> 'activated'
          and "sync_connect_generation_attempt"."activation_receipt" is null
          and "sync_connect_generation_attempt"."activated_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_connect_generation_target` ON `sync_connect_generation_attempt` (`attempt_id`,`target_sync_generation_id`) WHERE "sync_connect_generation_attempt"."target_sync_generation_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_sync_connect_generation_state` ON `sync_connect_generation_attempt` (`attempt_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `sync_cursor` (
	`sync_generation_id` text PRIMARY KEY NOT NULL,
	`provider_epoch` text NOT NULL,
	`committed_cursor` text,
	`pending_base_cursor` text,
	`pending_page_token` text,
	`inventory_complete` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_provider_binding`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_cursor_pending_pair_check" CHECK(("sync_cursor"."pending_page_token" is null and "sync_cursor"."pending_base_cursor" is null)
        or ("sync_cursor"."pending_page_token" is not null and "sync_cursor"."pending_base_cursor" is not null))
);
--> statement-breakpoint
CREATE TABLE `sync_entity_lifecycle` (
	`sync_generation_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`incarnation` integer NOT NULL,
	`state` text NOT NULL,
	`hlc_wall_ms` integer NOT NULL,
	`hlc_counter` integer NOT NULL,
	`writer_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`device_seq` integer NOT NULL,
	`change_set_id` text NOT NULL,
	`mutation_index` integer NOT NULL,
	PRIMARY KEY(`sync_generation_id`, `entity_kind`, `entity_id`),
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`change_set_id`,`mutation_index`) REFERENCES `sync_mutation`(`change_set_id`,`mutation_index`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_entity_lifecycle_state_check" CHECK("sync_entity_lifecycle"."state" in ('live', 'trashed', 'purged')),
	CONSTRAINT "sync_entity_lifecycle_clock_check" CHECK("sync_entity_lifecycle"."incarnation" >= 0 and "sync_entity_lifecycle"."hlc_wall_ms" >= 0 and "sync_entity_lifecycle"."hlc_counter" >= 0
        and "sync_entity_lifecycle"."device_seq" >= 1 and "sync_entity_lifecycle"."mutation_index" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_sync_entity_lifecycle_state` ON `sync_entity_lifecycle` (`sync_generation_id`,`state`);--> statement-breakpoint
CREATE TABLE `sync_field_clock` (
	`sync_generation_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`incarnation` integer NOT NULL,
	`field_key` text NOT NULL,
	`hlc_wall_ms` integer NOT NULL,
	`hlc_counter` integer NOT NULL,
	`writer_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`device_seq` integer NOT NULL,
	`change_set_id` text NOT NULL,
	`mutation_index` integer NOT NULL,
	PRIMARY KEY(`sync_generation_id`, `target_kind`, `target_id`, `incarnation`, `field_key`),
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`change_set_id`,`mutation_index`) REFERENCES `sync_mutation`(`change_set_id`,`mutation_index`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_field_clock_value_check" CHECK("sync_field_clock"."incarnation" >= 0 and "sync_field_clock"."hlc_wall_ms" >= 0 and "sync_field_clock"."hlc_counter" >= 0
        and "sync_field_clock"."device_seq" >= 1 and "sync_field_clock"."mutation_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE `sync_frontier_gap` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_generation_id` text NOT NULL,
	`writer_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`lane` text NOT NULL,
	`first_seq` integer NOT NULL,
	`last_seq` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`observed_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_frontier_gap_lane_check" CHECK("sync_frontier_gap"."lane" in ('received', 'applied', 'published')),
	CONSTRAINT "sync_frontier_gap_range_check" CHECK("sync_frontier_gap"."first_seq" >= 1 and "sync_frontier_gap"."last_seq" >= "sync_frontier_gap"."first_seq"),
	CONSTRAINT "sync_frontier_gap_state_check" CHECK(("sync_frontier_gap"."state" = 'open' and "sync_frontier_gap"."resolved_at" is null)
        or ("sync_frontier_gap"."state" = 'resolved' and "sync_frontier_gap"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_frontier_gap_range` ON `sync_frontier_gap` (`sync_generation_id`,`writer_id`,`writer_epoch`,`lane`,`first_seq`,`last_seq`);--> statement-breakpoint
CREATE INDEX `idx_sync_frontier_gap_open` ON `sync_frontier_gap` (`sync_generation_id`,`state`);--> statement-breakpoint
CREATE TABLE `sync_frontier` (
	`sync_generation_id` text NOT NULL,
	`writer_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`received_seq` integer DEFAULT 0 NOT NULL,
	`applied_seq` integer DEFAULT 0 NOT NULL,
	`published_seq` integer DEFAULT 0 NOT NULL,
	`segment_head_sha256` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`sync_generation_id`, `writer_id`, `writer_epoch`),
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_frontier_sequence_check" CHECK("sync_frontier"."received_seq" >= 0 and "sync_frontier"."applied_seq" >= 0 and "sync_frontier"."published_seq" >= 0),
	CONSTRAINT "sync_frontier_head_hash_check" CHECK("sync_frontier"."segment_head_sha256" is null or (
        length("sync_frontier"."segment_head_sha256") = 64
        and "sync_frontier"."segment_head_sha256" not glob '*[^0-9a-f]*'
      ))
);
--> statement-breakpoint
CREATE TABLE `sync_local_object` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_generation_id` text NOT NULL,
	`object_kind` text NOT NULL,
	`logical_key_id` text NOT NULL,
	`storage_ref` text NOT NULL,
	`stored_sha256` text NOT NULL,
	`content_sha256` text,
	`size_bytes` integer NOT NULL,
	`codec` text NOT NULL,
	`state` text DEFAULT 'staged' NOT NULL,
	`created_at` text NOT NULL,
	`verified_at` text,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_local_object_kind_check" CHECK("sync_local_object"."object_kind" in (
		'segment', 'genesis', 'checkpoint', 'snapshot-commit', 'blob',
		'quarantine'
	)),
	CONSTRAINT "sync_local_object_hash_check" CHECK(length("sync_local_object"."stored_sha256") = 64
        and "sync_local_object"."stored_sha256" not glob '*[^0-9a-f]*'
        and ("sync_local_object"."content_sha256" is null or (
          length("sync_local_object"."content_sha256") = 64
		  and "sync_local_object"."content_sha256" not glob '*[^0-9a-f]*'
		))),
	CONSTRAINT "sync_local_object_size_check" CHECK("sync_local_object"."size_bytes" >= 0),
	CONSTRAINT "sync_local_object_state_check" CHECK("sync_local_object"."state" in ('staged', 'verified', 'publishing', 'published', 'quarantined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_local_object_logical_key` ON `sync_local_object` (`sync_generation_id`,`logical_key_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_local_object_state` ON `sync_local_object` (`sync_generation_id`,`state`);--> statement-breakpoint
CREATE TABLE `sync_mutation` (
	`change_set_id` text NOT NULL,
	`mutation_index` integer NOT NULL,
	`target_family` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`incarnation` integer NOT NULL,
	`action` text NOT NULL,
	`payload_version` integer DEFAULT 1 NOT NULL,
	`payload_cbor` blob NOT NULL,
	`payload_sha256` text NOT NULL,
	PRIMARY KEY(`change_set_id`, `mutation_index`),
	FOREIGN KEY (`change_set_id`) REFERENCES `sync_change_set`(`change_set_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_mutation_index_check" CHECK("sync_mutation"."mutation_index" >= 0),
	CONSTRAINT "sync_mutation_incarnation_check" CHECK("sync_mutation"."incarnation" >= 0),
	CONSTRAINT "sync_mutation_payload_version_check" CHECK("sync_mutation"."payload_version" = 1),
	CONSTRAINT "sync_mutation_family_check" CHECK("sync_mutation"."target_family" in ('entity', 'set', 'order', 'yjs', 'asset', 'sync-generation')),
	CONSTRAINT "sync_mutation_action_check" CHECK("sync_mutation"."action" in (
        'entity.create', 'field.set', 'tuple.set', 'set.add', 'set.remove',
        'order.move', 'order.rebalance', 'entity.trash', 'entity.restore',
        'entity.purge', 'sync-generation.purge', 'yjs.update', 'asset.bind', 'asset.unbind'
      )),
	CONSTRAINT "sync_mutation_hash_check" CHECK(length("sync_mutation"."payload_sha256") = 64 and "sync_mutation"."payload_sha256" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `idx_sync_mutation_target` ON `sync_mutation` (`target_family`,`target_kind`,`target_id`,`incarnation`);--> statement-breakpoint
CREATE TABLE `sync_order_register` (
	`sync_generation_id` text NOT NULL,
	`list_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`incarnation` integer NOT NULL,
	`position_key` text NOT NULL,
	`hlc_wall_ms` integer NOT NULL,
	`hlc_counter` integer NOT NULL,
	`writer_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`device_seq` integer NOT NULL,
	`change_set_id` text NOT NULL,
	`mutation_index` integer NOT NULL,
	PRIMARY KEY(`sync_generation_id`, `list_kind`, `entity_id`, `incarnation`),
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`change_set_id`,`mutation_index`) REFERENCES `sync_mutation`(`change_set_id`,`mutation_index`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_order_register_clock_check" CHECK("sync_order_register"."incarnation" >= 0 and "sync_order_register"."hlc_wall_ms" >= 0 and "sync_order_register"."hlc_counter" >= 0
        and "sync_order_register"."device_seq" >= 1 and "sync_order_register"."mutation_index" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_sync_order_register_position` ON `sync_order_register` (`sync_generation_id`,`list_kind`,`owner_id`,`position_key`,`entity_id`);--> statement-breakpoint
CREATE TABLE `sync_provider_account` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton_key` integer DEFAULT 1 NOT NULL,
	`authority_id` text DEFAULT 'app' NOT NULL,
	`provider_kind` text NOT NULL,
	`authority_generation` integer NOT NULL,
	`account_subject_id` text NOT NULL,
	`credential_secret_ref` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`authority_id`,`provider_kind`,`authority_generation`) REFERENCES `sync_app_authority`(`id`,`mode`,`generation`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_provider_account_singleton_check" CHECK("sync_provider_account"."singleton_key" = 1),
	CONSTRAINT "sync_provider_account_kind_check" CHECK("sync_provider_account"."provider_kind" in ('google-drive', 'hosted')),
	CONSTRAINT "sync_provider_account_generation_check" CHECK("sync_provider_account"."authority_generation" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_provider_account_singleton` ON `sync_provider_account` (`singleton_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_provider_account_subject` ON `sync_provider_account` (`provider_kind`,`account_subject_id`);--> statement-breakpoint
CREATE TABLE `sync_provider_binding` (
	`sync_generation_id` text PRIMARY KEY NOT NULL,
	`provider_account_id` text NOT NULL,
	`provider_namespace` text NOT NULL,
	`provider_generation_ref` text,
	`state` text DEFAULT 'connecting' NOT NULL,
	`connected_at` text,
	`last_pull_success_at` text,
	`last_publish_success_at` text,
	`last_converged_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_account_id`) REFERENCES `sync_provider_account`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_provider_binding_state_check" CHECK("sync_provider_binding"."state" in (
        'connecting', 'discovering', 'publishing-genesis', 'restoring',
        'ready', 'paused', 'needs-reauth', 'blocked-update',
        'blocked-corrupt', 'purged'
      ))
);
--> statement-breakpoint
CREATE INDEX `idx_sync_provider_binding_account` ON `sync_provider_binding` (`provider_account_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_provider_binding_state` ON `sync_provider_binding` (`state`);--> statement-breakpoint
CREATE TABLE `sync_quarantined_object` (
	`quarantine_id` text PRIMARY KEY NOT NULL,
	`sync_generation_id` text NOT NULL,
	`remote_object_id` text,
	`local_object_id` text NOT NULL,
	`reason` text NOT NULL,
	`observed_protocol` text,
	`observed_version` integer,
	`stored_sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`remote_object_id`) REFERENCES `sync_remote_object`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`local_object_id`) REFERENCES `sync_local_object`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_quarantine_hash_check" CHECK(length("sync_quarantined_object"."stored_sha256") = 64 and "sync_quarantined_object"."stored_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "sync_quarantine_size_check" CHECK("sync_quarantined_object"."size_bytes" >= 0),
	CONSTRAINT "sync_quarantine_state_check" CHECK(("sync_quarantined_object"."state" in ('blocked-update', 'blocked-corrupt') and "sync_quarantined_object"."resolved_at" is null)
        or ("sync_quarantined_object"."state" in ('released', 'discarded') and "sync_quarantined_object"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_quarantine_local_object` ON `sync_quarantined_object` (`local_object_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_quarantine_state` ON `sync_quarantined_object` (`sync_generation_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `sync_remote_object` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_generation_id` text NOT NULL,
	`provider_object_id` text NOT NULL,
	`logical_key_id` text NOT NULL,
	`object_kind` text NOT NULL,
	`stored_sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`provider_version` text,
	`provider_etag` text,
	`observed_cursor` text,
	`first_observed_at` text NOT NULL,
	`last_observed_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_remote_object_kind_check" CHECK("sync_remote_object"."object_kind" in (
		'segment', 'genesis', 'checkpoint', 'snapshot-commit', 'blob'
	)),
	CONSTRAINT "sync_remote_object_hash_check" CHECK(length("sync_remote_object"."stored_sha256") = 64 and "sync_remote_object"."stored_sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "sync_remote_object_size_check" CHECK("sync_remote_object"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_remote_object_provider_id` ON `sync_remote_object` (`sync_generation_id`,`provider_object_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_remote_object_logical_key` ON `sync_remote_object` (`sync_generation_id`,`logical_key_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_remote_object_removed` ON `sync_remote_object` (`sync_generation_id`,`removed_at`);--> statement-breakpoint
CREATE TABLE `sync_restore_attempt` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`source_sync_generation_id` text NOT NULL,
	`source_checkpoint_id` text,
	`target_project_id` text,
	`staging_ref` text NOT NULL,
	`state` text DEFAULT 'downloading' NOT NULL,
	`validation_code` text,
	`activation_receipt` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`source_sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_checkpoint_id`) REFERENCES `sync_checkpoint`(`checkpoint_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_restore_state_check" CHECK("sync_restore_attempt"."state" in (
        'downloading', 'validating', 'staging-assets', 'activating',
        'completed', 'failed', 'cancelled'
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_restore_active_generation` ON `sync_restore_attempt` (`source_sync_generation_id`) WHERE "sync_restore_attempt"."state" in ('downloading', 'validating', 'staging-assets', 'activating');--> statement-breakpoint
CREATE INDEX `idx_sync_restore_state` ON `sync_restore_attempt` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `sync_segment` (
	`segment_id` text PRIMARY KEY NOT NULL,
	`sync_generation_id` text NOT NULL,
	`writer_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`first_seq` integer NOT NULL,
	`last_seq` integer NOT NULL,
	`change_set_count` integer NOT NULL,
	`previous_segment_sha256` text,
	`required_blob_ids_cbor` blob NOT NULL,
	`local_object_id` text NOT NULL,
	`segment_sha256` text NOT NULL,
	`state` text DEFAULT 'sealed' NOT NULL,
	`created_at` text NOT NULL,
	`published_at` text,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`local_object_id`) REFERENCES `sync_local_object`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_segment_range_check" CHECK("sync_segment"."first_seq" >= 1 and "sync_segment"."last_seq" >= "sync_segment"."first_seq"
        and "sync_segment"."change_set_count" = "sync_segment"."last_seq" - "sync_segment"."first_seq" + 1),
	CONSTRAINT "sync_segment_hash_check" CHECK(length("sync_segment"."segment_sha256") = 64
        and "sync_segment"."segment_sha256" not glob '*[^0-9a-f]*'
        and ("sync_segment"."previous_segment_sha256" is null or (
          length("sync_segment"."previous_segment_sha256") = 64
          and "sync_segment"."previous_segment_sha256" not glob '*[^0-9a-f]*'
        ))),
	CONSTRAINT "sync_segment_state_check" CHECK("sync_segment"."state" in ('sealed', 'publishing', 'published', 'quarantined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_segment_writer_range` ON `sync_segment` (`sync_generation_id`,`writer_id`,`writer_epoch`,`first_seq`,`last_seq`);--> statement-breakpoint
CREATE INDEX `idx_sync_segment_state` ON `sync_segment` (`sync_generation_id`,`state`,`first_seq`);--> statement-breakpoint
CREATE TABLE `sync_set_tag` (
	`sync_generation_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`incarnation` integer NOT NULL,
	`set_key` text NOT NULL,
	`value_key` text NOT NULL,
	`value_cbor` blob NOT NULL,
	`add_tag` text NOT NULL,
	`add_change_set_id` text NOT NULL,
	`add_mutation_index` integer NOT NULL,
	`removed_by_change_set_id` text,
	`removed_by_mutation_index` integer,
	PRIMARY KEY(`sync_generation_id`, `owner_kind`, `owner_id`, `incarnation`, `set_key`, `value_key`, `add_tag`),
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`add_change_set_id`,`add_mutation_index`) REFERENCES `sync_mutation`(`change_set_id`,`mutation_index`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`removed_by_change_set_id`,`removed_by_mutation_index`) REFERENCES `sync_mutation`(`change_set_id`,`mutation_index`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_set_tag_incarnation_check" CHECK("sync_set_tag"."incarnation" >= 0),
	CONSTRAINT "sync_set_tag_remove_pair_check" CHECK(("sync_set_tag"."removed_by_change_set_id" is null and "sync_set_tag"."removed_by_mutation_index" is null)
        or ("sync_set_tag"."removed_by_change_set_id" is not null and "sync_set_tag"."removed_by_mutation_index" >= 0))
);
--> statement-breakpoint
CREATE INDEX `idx_sync_set_tag_live_value` ON `sync_set_tag` (`sync_generation_id`,`owner_kind`,`owner_id`,`set_key`,`value_key`,`removed_by_change_set_id`);--> statement-breakpoint
CREATE TABLE `sync_transfer` (
	`transfer_id` text PRIMARY KEY NOT NULL,
	`sync_generation_id` text NOT NULL,
	`direction` text NOT NULL,
	`object_kind` text NOT NULL,
	`logical_key_id` text NOT NULL,
	`local_object_id` text,
	`remote_object_id` text,
	`expected_stored_sha256` text NOT NULL,
	`total_bytes` integer NOT NULL,
	`transferred_bytes` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`session_secret_ref` text,
	`last_error_code` text,
	`next_attempt_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`local_object_id`) REFERENCES `sync_local_object`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`remote_object_id`) REFERENCES `sync_remote_object`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_transfer_direction_check" CHECK("sync_transfer"."direction" in ('upload', 'download')),
	CONSTRAINT "sync_transfer_object_kind_check" CHECK("sync_transfer"."object_kind" in (
		'segment', 'genesis', 'checkpoint', 'snapshot-commit', 'blob'
	)),
	CONSTRAINT "sync_transfer_state_check" CHECK("sync_transfer"."state" in ('pending', 'running', 'retry-wait', 'completed', 'cancelled', 'failed')),
	CONSTRAINT "sync_transfer_progress_check" CHECK("sync_transfer"."total_bytes" >= 0 and "sync_transfer"."transferred_bytes" >= 0
        and "sync_transfer"."transferred_bytes" <= "sync_transfer"."total_bytes" and "sync_transfer"."attempt_count" >= 0),
	CONSTRAINT "sync_transfer_hash_check" CHECK(length("sync_transfer"."expected_stored_sha256") = 64
        and "sync_transfer"."expected_stored_sha256" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_transfer_active_object` ON `sync_transfer` (`sync_generation_id`,`direction`,`logical_key_id`) WHERE "sync_transfer"."state" in ('pending', 'running', 'retry-wait');--> statement-breakpoint
CREATE INDEX `idx_sync_transfer_schedule` ON `sync_transfer` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `sync_generation` (
	`sync_generation_id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`project_sync_id` text NOT NULL,
	`generation_number` integer DEFAULT 1 NOT NULL,
	`protocol_version` integer DEFAULT 1 NOT NULL,
	`domain_schema_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`retired_at` text,
	`purged_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sync_generation_number_check" CHECK("sync_generation"."generation_number" >= 1),
	CONSTRAINT "sync_generation_protocol_check" CHECK("sync_generation"."protocol_version" = 1),
	CONSTRAINT "sync_generation_schema_check" CHECK("sync_generation"."domain_schema_version" >= 1),
	CONSTRAINT "sync_generation_status_check" CHECK(("sync_generation"."status" in ('active', 'staged')
          and "sync_generation"."retired_at" is null
          and "sync_generation"."purged_at" is null)
        or ("sync_generation"."status" = 'retired'
          and "sync_generation"."retired_at" is not null
          and "sync_generation"."purged_at" is null)
        or ("sync_generation"."status" = 'purged' and "sync_generation"."purged_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_generation_project_sync_number` ON `sync_generation` (`project_sync_id`,`generation_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_generation_identity_project_sync` ON `sync_generation` (`sync_generation_id`,`project_sync_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_generation_active_project` ON `sync_generation` (`project_id`) WHERE "sync_generation"."project_id" is not null and "sync_generation"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_generation_staged_project` ON `sync_generation` (`project_id`) WHERE "sync_generation"."project_id" is not null and "sync_generation"."status" = 'staged';--> statement-breakpoint
CREATE INDEX `idx_sync_generation_project` ON `sync_generation` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_generation_project_sync` ON `sync_generation` (`project_sync_id`);--> statement-breakpoint
CREATE TABLE `sync_generation_purge` (
	`sync_generation_id` text PRIMARY KEY NOT NULL,
	`hlc_wall_ms` integer NOT NULL,
	`hlc_counter` integer NOT NULL,
	`writer_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`device_seq` integer NOT NULL,
	`change_set_id` text NOT NULL,
	`mutation_index` integer NOT NULL,
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`change_set_id`,`mutation_index`) REFERENCES `sync_mutation`(`change_set_id`,`mutation_index`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_generation_purge_clock_check" CHECK("sync_generation_purge"."hlc_wall_ms" >= 0 and "sync_generation_purge"."hlc_counter" >= 0
        and "sync_generation_purge"."device_seq" >= 1 and "sync_generation_purge"."mutation_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE `sync_generation_writer_state` (
	`sync_generation_id` text NOT NULL,
	`writer_id` text NOT NULL,
	`writer_epoch` text NOT NULL,
	`installation_id` text NOT NULL,
	`next_device_seq` integer DEFAULT 1 NOT NULL,
	`hlc_wall_ms` integer DEFAULT 0 NOT NULL,
	`hlc_counter` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`retired_at` text,
	PRIMARY KEY(`sync_generation_id`, `writer_id`, `writer_epoch`),
	FOREIGN KEY (`sync_generation_id`) REFERENCES `sync_generation`(`sync_generation_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sync_writer_next_sequence_check" CHECK("sync_generation_writer_state"."next_device_seq" >= 1),
	CONSTRAINT "sync_writer_hlc_check" CHECK("sync_generation_writer_state"."hlc_wall_ms" >= 0 and "sync_generation_writer_state"."hlc_counter" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sync_generation_active_writer` ON `sync_generation_writer_state` (`sync_generation_id`) WHERE "sync_generation_writer_state"."retired_at" is null;--> statement-breakpoint
CREATE TABLE `timeline_marker` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`narrative_order` real NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`drift_node_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`drift_node_id`) REFERENCES `book_node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_timeline_marker_project` ON `timeline_marker` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_timeline_marker_drift` ON `timeline_marker` (`drift_node_id`);--> statement-breakpoint
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
CREATE INDEX `idx_yjs_revision_provenance_doc_revision` ON `yjs_document_revision_provenance` (`document_id`,`revision`);--> statement-breakpoint
CREATE TABLE `yjs_document_revision` (
	`document_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
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
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_yjs_prose_command_direction` ON `yjs_prose_command_receipt` (`command_id`,`direction`);--> statement-breakpoint
CREATE INDEX `idx_yjs_prose_command_doc_revision` ON `yjs_prose_command_receipt` (`document_id`,`committed_revision`);--> statement-breakpoint
CREATE TABLE `yjs_snapshots` (
	`document_id` text PRIMARY KEY NOT NULL,
	`state_blob` blob NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_yjs_snapshot_doc` ON `yjs_snapshots` (`document_id`);--> statement-breakpoint
CREATE TABLE `yjs_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`update_blob` blob NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_yjs_updates_doc` ON `yjs_updates` (`document_id`);
--> statement-breakpoint
CREATE TRIGGER `protect_locked_relation_type_update`
BEFORE UPDATE ON `entity_relation_type`
WHEN OLD.`locked` = 1 AND (
	NEW.`id` IS NOT OLD.`id`
	OR NEW.`project_id` IS NOT OLD.`project_id`
	OR NEW.`name` IS NOT OLD.`name`
	OR NEW.`normalized_name` IS NOT OLD.`normalized_name`
	OR NEW.`description` IS NOT OLD.`description`
	OR NEW.`orientation` IS NOT OLD.`orientation`
	OR NEW.`system_key` IS NOT OLD.`system_key`
	OR NEW.`locked` IS NOT OLD.`locked`
	OR NEW.`source_role` IS NOT OLD.`source_role`
	OR NEW.`target_role` IS NOT OLD.`target_role`
	OR NEW.`created_at` IS NOT OLD.`created_at`
	OR NEW.`updated_at` IS NOT OLD.`updated_at`
)
BEGIN
	SELECT RAISE(ABORT, 'locked relation type cannot be updated');
END;
--> statement-breakpoint
CREATE TRIGGER `protect_locked_relation_type_delete`
BEFORE DELETE ON `entity_relation_type`
WHEN OLD.`locked` = 1 AND EXISTS (
	SELECT 1 FROM `project` WHERE `id` = OLD.`project_id`
)
BEGIN
	SELECT RAISE(ABORT, 'locked relation type cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `protect_locked_relation_type_endpoint_insert`
BEFORE INSERT ON `entity_relation_type_endpoint_kind`
WHEN EXISTS (
	SELECT 1
	FROM `entity_relation_type`
	WHERE `id` = NEW.`relation_type_id`
		AND `locked` = 1
		AND NOT (
			`system_key` = 'generic-association'
			AND (
				(NEW.`side` = 'source' AND NEW.`entity_kind` IN ('comment', 'library_item'))
				OR (NEW.`side` = 'target' AND NEW.`entity_kind` IN ('node', 'element', 'patch', 'category', 'storyline'))
			)
		)
)
BEGIN
	SELECT RAISE(ABORT, 'invalid locked relation type endpoint');
END;
--> statement-breakpoint
CREATE TRIGGER `protect_locked_relation_type_endpoint_update`
BEFORE UPDATE ON `entity_relation_type_endpoint_kind`
WHEN EXISTS (
	SELECT 1
	FROM `entity_relation_type` AS `relation_type`
	JOIN `project` ON `project`.`id` = `relation_type`.`project_id`
	WHERE `relation_type`.`id` = OLD.`relation_type_id`
		AND `relation_type`.`locked` = 1
)
BEGIN
	SELECT RAISE(ABORT, 'locked relation type endpoints cannot be updated');
END;
--> statement-breakpoint
CREATE TRIGGER `protect_locked_relation_type_endpoint_delete`
BEFORE DELETE ON `entity_relation_type_endpoint_kind`
WHEN EXISTS (
	SELECT 1
	FROM `entity_relation_type` AS `relation_type`
	JOIN `project` ON `project`.`id` = `relation_type`.`project_id`
	WHERE `relation_type`.`id` = OLD.`relation_type_id`
		AND `relation_type`.`locked` = 1
)
BEGIN
	SELECT RAISE(ABORT, 'locked relation type endpoints cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_write_effect_route_insert`
BEFORE INSERT ON `agent_runtime_write_effect`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_session` AS `session`
	WHERE `session`.`id` = NEW.`session_id`
		AND `session`.`project_id` = NEW.`project_id`
		AND `session`.`route_kind` = NEW.`route_kind`
		AND `session`.`conversation_id` IS NEW.`conversation_id`
		AND `session`.`goal_run_id` IS NEW.`goal_run_id`
		AND `session`.`chapter_id` IS NEW.`chapter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'agent write effect route provenance mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_write_effect_route_update`
BEFORE UPDATE OF
	`project_id`,
	`route_kind`,
	`conversation_id`,
	`goal_run_id`,
	`chapter_id`,
	`session_id`
ON `agent_runtime_write_effect`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_session` AS `session`
	WHERE `session`.`id` = NEW.`session_id`
		AND `session`.`project_id` = NEW.`project_id`
		AND `session`.`route_kind` = NEW.`route_kind`
		AND `session`.`conversation_id` IS NEW.`conversation_id`
		AND `session`.`goal_run_id` IS NEW.`goal_run_id`
		AND `session`.`chapter_id` IS NEW.`chapter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'agent write effect route provenance mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_session_effect_route_update`
BEFORE UPDATE OF
	`project_id`,
	`route_kind`,
	`conversation_id`,
	`goal_run_id`,
	`chapter_id`
ON `agent_runtime_session`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `agent_runtime_write_effect` AS `effect`
	WHERE `effect`.`session_id` = OLD.`id`
		AND (
			`effect`.`project_id` <> NEW.`project_id`
			OR `effect`.`route_kind` <> NEW.`route_kind`
			OR `effect`.`conversation_id` IS NOT NEW.`conversation_id`
			OR `effect`.`goal_run_id` IS NOT NEW.`goal_run_id`
			OR `effect`.`chapter_id` IS NOT NEW.`chapter_id`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'agent runtime session route has durable write effects');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_read_receipt_immutable`
BEFORE UPDATE ON `agent_runtime_read_receipt`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent read receipt is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_read_observation_immutable`
BEFORE UPDATE ON `agent_runtime_read_observation`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent read observation is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_write_expectation_exact_insert`
BEFORE INSERT ON `agent_runtime_write_expectation`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_read_observation` AS `observation`
	WHERE `observation`.`id` = NEW.`observation_id`
		AND `observation`.`receipt_id` = NEW.`read_receipt_id`
		AND `observation`.`project_id` = NEW.`project_id`
		AND `observation`.`session_id` = NEW.`session_id`
		AND `observation`.`turn_id` = NEW.`read_turn_id`
		AND `observation`.`tool_call_id` = NEW.`read_tool_call_id`
		AND `observation`.`entity_kind` = NEW.`entity_kind`
		AND `observation`.`entity_id` = NEW.`entity_id`
		AND `observation`.`revision` = NEW.`expected_revision`
		AND `observation`.`state_vector` IS NEW.`expected_state_vector`
		AND `observation`.`state_hash` IS NEW.`expected_state_hash`
)
BEGIN
	SELECT RAISE(ABORT, 'agent write expectation drifted from read observation');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_write_expectation_immutable`
BEFORE UPDATE ON `agent_runtime_write_expectation`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent write expectation is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_result_blob_immutable`
BEFORE UPDATE ON `agent_runtime_result_blob`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent result blob is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_result_artifact_immutable`
BEFORE UPDATE ON `agent_runtime_result_artifact`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent result artifact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_result_artifact_delete_orphan`
AFTER DELETE ON `agent_runtime_result_artifact`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_result_artifact`
	WHERE `content_hash` = OLD.`content_hash`
)
BEGIN
	DELETE FROM `agent_runtime_result_blob`
	WHERE `content_hash` = OLD.`content_hash`;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_write_effect_authorization_insert`
BEFORE INSERT ON `agent_runtime_write_effect`
FOR EACH ROW
WHEN
	NOT (
		(NEW.`authorization_kind` IS NULL
			AND NEW.`authorization_request_id` IS NULL
			AND NEW.`authorization_arguments_hash` IS NULL
			AND NEW.`authorized_at` IS NULL)
		OR
		(NEW.`authorization_kind` = 'automatic'
			AND NEW.`authorization_request_id` IS NULL
			AND NEW.`authorization_arguments_hash` IS NOT NULL
			AND length(NEW.`authorization_arguments_hash`) > 0
			AND NEW.`authorized_at` IS NOT NULL
			AND length(NEW.`authorized_at`) > 0)
		OR
		(NEW.`authorization_kind` = 'author_approved'
			AND NEW.`authorization_request_id` IS NOT NULL
			AND length(NEW.`authorization_request_id`) > 0
			AND NEW.`authorization_arguments_hash` IS NOT NULL
			AND length(NEW.`authorization_arguments_hash`) > 0
			AND NEW.`authorized_at` IS NOT NULL
			AND length(NEW.`authorized_at`) > 0)
	)
BEGIN
	SELECT RAISE(ABORT, 'invalid agent write authorization');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_write_effect_authorization_immutable`
BEFORE UPDATE OF
	`authorization_kind`,
	`authorization_request_id`,
	`authorization_arguments_hash`,
	`authorized_at`
ON `agent_runtime_write_effect`
FOR EACH ROW
WHEN
	OLD.`authorization_kind` IS NOT NEW.`authorization_kind`
	OR OLD.`authorization_request_id` IS NOT NEW.`authorization_request_id`
	OR OLD.`authorization_arguments_hash` IS NOT NEW.`authorization_arguments_hash`
	OR OLD.`authorized_at` IS NOT NEW.`authorized_at`
BEGIN
	SELECT RAISE(ABORT, 'agent write authorization is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_element_patch_receipt_provenance`
BEFORE INSERT ON `agent_runtime_element_patch_receipt`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_write_effect` AS `effect`
	WHERE `effect`.`id` = NEW.`effect_id`
		AND `effect`.`project_id` = NEW.`project_id`
		AND `effect`.`session_id` = NEW.`session_id`
		AND `effect`.`tool_name` = NEW.`tool_name`
		AND `effect`.`phase` IN (
			'mutation_started',
			'effect_committed',
			'result_committed'
		)
)
BEGIN
	SELECT RAISE(ABORT, 'agent element patch receipt provenance mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_element_patch_receipt_immutable`
BEFORE UPDATE ON `agent_runtime_element_patch_receipt`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent element patch receipt is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_entity_write_receipt_provenance`
BEFORE INSERT ON `agent_runtime_entity_write_receipt`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM `agent_runtime_write_effect` AS `effect`
	WHERE `effect`.`id` = NEW.`effect_id`
		AND `effect`.`project_id` = NEW.`project_id`
		AND `effect`.`session_id` = NEW.`session_id`
		AND (
			`effect`.`tool_name` = NEW.`tool_name`
			OR (
				`effect`.`tool_name` IN (
					'create_chapter', 'rename_chapter', 'set_chapter_summary',
					'revise_chapter', 'replace_chapter_body', 'delete_chapter',
					'create_inspiration', 'rename_inspiration', 'set_inspiration_summary',
					'revise_inspiration', 'replace_inspiration_body', 'delete_inspiration',
					'revise_element', 'replace_element_body',
					'create_element_category', 'update_element_category',
					'replace_element_category_body', 'delete_element_category',
					'revise_storyline', 'replace_storyline_body', 'delete_storyline',
					'add_chapter_to_storyline', 'remove_chapter_from_storyline',
					'set_chapter_primary_storyline', 'replace_storyline_chapters',
					'create_relation', 'update_relation', 'delete_relation',
					'update_comment',
					'create_author_rule', 'update_author_rule', 'delete_author_rule'
				)
				AND json_valid(`effect`.`arguments_json`) = 1
				AND json_extract(`effect`.`arguments_json`, '$.__workspaceCommand.name') = NEW.`tool_name`
			)
		)
		AND `effect`.`phase` IN ('mutation_started', 'effect_committed', 'result_committed')
)
BEGIN
	SELECT RAISE(ABORT, 'agent entity write receipt provenance mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_entity_write_receipt_immutable`
BEFORE UPDATE ON `agent_runtime_entity_write_receipt`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent entity write receipt is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `project_asset_immutable_update`
BEFORE UPDATE ON `project_asset`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'project asset metadata is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `library_item_asset_binding_insert`
BEFORE INSERT ON `library_item`
WHEN NEW.`asset_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `project_asset`
  WHERE `id` = NEW.`asset_id`
    AND `project_id` = NEW.`project_id`
    AND `kind` = NEW.`kind`
)
BEGIN
  SELECT RAISE(ABORT, 'library item asset binding mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `library_item_asset_binding_update`
BEFORE UPDATE OF `project_id`, `kind`, `asset_id` ON `library_item`
WHEN NEW.`asset_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `project_asset`
  WHERE `id` = NEW.`asset_id`
    AND `project_id` = NEW.`project_id`
    AND `kind` = NEW.`kind`
)
BEGIN
  SELECT RAISE(ABORT, 'library item asset binding mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `library_item_asset_owner_insert`
BEFORE INSERT ON `library_item`
WHEN NEW.`asset_id` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `element` WHERE `portrait_asset_id` = NEW.`asset_id`
)
BEGIN
  SELECT RAISE(ABORT, 'project asset already has an owner');
END;
--> statement-breakpoint
CREATE TRIGGER `library_item_asset_owner_update`
BEFORE UPDATE OF `asset_id` ON `library_item`
WHEN NEW.`asset_id` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `element` WHERE `portrait_asset_id` = NEW.`asset_id`
)
BEGIN
  SELECT RAISE(ABORT, 'project asset already has an owner');
END;
--> statement-breakpoint
CREATE TRIGGER `element_portrait_asset_binding_insert`
BEFORE INSERT ON `element`
WHEN NEW.`portrait_asset_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `project_asset`
  WHERE `id` = NEW.`portrait_asset_id`
    AND `project_id` = NEW.`project_id`
    AND `kind` = 'image'
)
BEGIN
  SELECT RAISE(ABORT, 'element portrait asset binding mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `element_portrait_asset_binding_update`
BEFORE UPDATE OF `project_id`, `portrait_asset_id` ON `element`
WHEN NEW.`portrait_asset_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `project_asset`
  WHERE `id` = NEW.`portrait_asset_id`
    AND `project_id` = NEW.`project_id`
    AND `kind` = 'image'
)
BEGIN
  SELECT RAISE(ABORT, 'element portrait asset binding mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `element_portrait_asset_owner_insert`
BEFORE INSERT ON `element`
WHEN NEW.`portrait_asset_id` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `library_item` WHERE `asset_id` = NEW.`portrait_asset_id`
)
BEGIN
  SELECT RAISE(ABORT, 'project asset already has an owner');
END;
--> statement-breakpoint
CREATE TRIGGER `element_portrait_asset_owner_update`
BEFORE UPDATE OF `portrait_asset_id` ON `element`
WHEN NEW.`portrait_asset_id` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `library_item` WHERE `asset_id` = NEW.`portrait_asset_id`
)
BEGIN
  SELECT RAISE(ABORT, 'project asset already has an owner');
END;
--> statement-breakpoint
INSERT INTO `sync_app_authority` (
  `id`, `mode`, `generation`, `transition_state`, `target_mode`, `attempt_id`, `updated_at`
) VALUES (
  'app', 'local', 1, 'stable', NULL, NULL, '1970-01-01T00:00:00.000Z'
);
--> statement-breakpoint
CREATE TRIGGER `trg_sync_app_authority_transition_guard`
BEFORE UPDATE ON `sync_app_authority`
FOR EACH ROW
WHEN
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`generation` < OLD.`generation`
  OR (
    NEW.`mode` = OLD.`mode`
    AND NEW.`generation` <> OLD.`generation`
  )
  OR (
    NEW.`mode` <> OLD.`mode`
    AND NOT (
      OLD.`transition_state` IN ('connecting', 'switching', 'disconnecting', 'blocked')
      AND OLD.`target_mode` = NEW.`mode`
      AND OLD.`attempt_id` IS NOT NULL
      AND NEW.`transition_state` = 'stable'
      AND NEW.`target_mode` IS NULL
      AND NEW.`attempt_id` IS NULL
      AND NEW.`generation` = OLD.`generation` + 1
      AND EXISTS (
        SELECT 1
        FROM `sync_connect_attempt` AS `attempt`
        WHERE `attempt`.`attempt_id` = OLD.`attempt_id`
          AND `attempt`.`authority_generation` = OLD.`generation`
          AND `attempt`.`target_mode` = NEW.`mode`
          AND `attempt`.`state` = 'completed'
          AND `attempt`.`completed_at` IS NOT NULL
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid sync app authority transition');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_app_authority_local_guard`
BEFORE UPDATE ON `sync_app_authority`
FOR EACH ROW
WHEN NEW.`mode` = 'local' AND (
  EXISTS (SELECT 1 FROM `sync_provider_account`)
  OR EXISTS (SELECT 1 FROM `sync_provider_binding`)
)
BEGIN
  SELECT RAISE(ABORT, 'local sync authority cannot retain a provider');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_provider_account_authority_insert`
BEFORE INSERT ON `sync_provider_account`
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM `sync_app_authority` AS `authority`
  WHERE `authority`.`id` = NEW.`authority_id`
    AND `authority`.`mode` = NEW.`provider_kind`
    AND `authority`.`generation` = NEW.`authority_generation`
    AND `authority`.`mode` <> 'local'
    AND EXISTS (
      SELECT 1
      FROM `sync_connect_attempt` AS `attempt`
      WHERE `attempt`.`authority_generation` + 1 = NEW.`authority_generation`
        AND `attempt`.`target_mode` = NEW.`provider_kind`
        AND `attempt`.`target_account_subject_id` = NEW.`account_subject_id`
        AND `attempt`.`target_credential_secret_ref` = NEW.`credential_secret_ref`
        AND `attempt`.`state` = 'completed'
        AND `attempt`.`completed_at` IS NOT NULL
    )
)
BEGIN
  SELECT RAISE(ABORT, 'sync provider account does not match app authority');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_provider_account_authority_update`
BEFORE UPDATE OF `authority_id`, `provider_kind`, `authority_generation` ON `sync_provider_account`
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM `sync_app_authority` AS `authority`
  WHERE `authority`.`id` = NEW.`authority_id`
    AND `authority`.`mode` = NEW.`provider_kind`
    AND `authority`.`generation` = NEW.`authority_generation`
    AND `authority`.`mode` <> 'local'
)
BEGIN
  SELECT RAISE(ABORT, 'sync provider account does not match app authority');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_provider_binding_authority_insert`
BEFORE INSERT ON `sync_provider_binding`
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM `sync_provider_account` AS `account`
  JOIN `sync_app_authority` AS `authority`
    ON `authority`.`id` = `account`.`authority_id`
   AND `authority`.`mode` = `account`.`provider_kind`
   AND `authority`.`generation` = `account`.`authority_generation`
  JOIN `sync_generation` AS `generation`
    ON `generation`.`sync_generation_id` = NEW.`sync_generation_id`
  WHERE `account`.`id` = NEW.`provider_account_id`
    AND `authority`.`mode` <> 'local'
    AND `generation`.`status` = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'sync provider binding does not match app authority');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_provider_binding_authority_update`
BEFORE UPDATE OF `sync_generation_id`, `provider_account_id` ON `sync_provider_binding`
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM `sync_provider_account` AS `account`
  JOIN `sync_app_authority` AS `authority`
    ON `authority`.`id` = `account`.`authority_id`
   AND `authority`.`mode` = `account`.`provider_kind`
   AND `authority`.`generation` = `account`.`authority_generation`
  JOIN `sync_generation` AS `generation`
    ON `generation`.`sync_generation_id` = NEW.`sync_generation_id`
  WHERE `account`.`id` = NEW.`provider_account_id`
    AND `authority`.`mode` <> 'local'
    AND `generation`.`status` = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'sync provider binding does not match app authority');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_connect_attempt_completed_insert`
BEFORE INSERT ON `sync_connect_attempt`
FOR EACH ROW
WHEN NEW.`state` = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'sync connect attempt must complete through activation');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_connect_attempt_completed_update`
BEFORE UPDATE OF `state`, `completed_at` ON `sync_connect_attempt`
FOR EACH ROW
WHEN NEW.`state` = 'completed' AND (
  EXISTS (
    SELECT 1
    FROM `sync_connect_generation_attempt` AS `generation_attempt`
    WHERE `generation_attempt`.`attempt_id` = NEW.`attempt_id`
      AND (
        `generation_attempt`.`state` <> 'activated'
        OR `generation_attempt`.`activation_receipt` IS NULL
        OR `generation_attempt`.`activated_at` IS NULL
      )
  )
  OR (
    NEW.`kind` NOT IN ('connect', 'restore')
    AND EXISTS (
      SELECT 1
      FROM `sync_generation` AS `generation`
      WHERE `generation`.`status` IN ('active', 'staged')
        AND NOT EXISTS (
          SELECT 1
          FROM `sync_connect_generation_attempt` AS `generation_attempt`
          WHERE `generation_attempt`.`attempt_id` = NEW.`attempt_id`
            AND (
              `generation_attempt`.`source_sync_generation_id` = `generation`.`sync_generation_id`
              OR `generation_attempt`.`target_sync_generation_id` = `generation`.`sync_generation_id`
            )
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'sync connect attempt is missing a sync generation activation receipt');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_connect_attempt_completed_immutable`
BEFORE UPDATE ON `sync_connect_attempt`
FOR EACH ROW
WHEN OLD.`state` = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'completed sync connect attempt is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_connect_generation_attempt_insert_guard`
BEFORE INSERT ON `sync_connect_generation_attempt`
FOR EACH ROW
WHEN NEW.`state` = 'activated' OR NOT EXISTS (
  SELECT 1
  FROM `sync_connect_attempt` AS `attempt`
  JOIN `sync_generation` AS `source_generation`
    ON `source_generation`.`sync_generation_id` = NEW.`source_sync_generation_id`
  LEFT JOIN `sync_generation` AS `target_generation`
    ON `target_generation`.`sync_generation_id` = NEW.`target_sync_generation_id`
  WHERE `attempt`.`attempt_id` = NEW.`attempt_id`
    AND `attempt`.`state` NOT IN ('completed', 'failed', 'cancelled')
    AND (
      `source_generation`.`status` = 'active'
      OR (
        `attempt`.`kind` IN ('connect', 'restore')
        AND NEW.`target_sync_generation_id` IS NULL
        AND `source_generation`.`status` = 'staged'
        AND `source_generation`.`project_id` IS NULL
      )
    )
    AND (
      (
        `attempt`.`kind` IN ('connect', 'disconnect')
        AND NEW.`target_sync_generation_id` IS NULL
      )
      OR (
        `attempt`.`kind` = 'restore'
        AND (
          NEW.`target_sync_generation_id` IS NULL
          OR (
            `target_generation`.`status` = 'staged'
            AND `target_generation`.`project_sync_id` = `source_generation`.`project_sync_id`
            AND `target_generation`.`generation_number` = `source_generation`.`generation_number` + 1
            AND `target_generation`.`project_id` IS `source_generation`.`project_id`
          )
        )
      )
      OR (
        `attempt`.`kind` = 'switch-provider'
        AND NEW.`target_sync_generation_id` IS NOT NULL
        AND `target_generation`.`status` = 'staged'
        AND `target_generation`.`project_sync_id` = `source_generation`.`project_sync_id`
        AND `target_generation`.`generation_number` = `source_generation`.`generation_number` + 1
        AND `target_generation`.`project_id` IS `source_generation`.`project_id`
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid sync connect generation staging');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_connect_generation_attempt_identity_guard`
BEFORE UPDATE OF `attempt_id`, `source_sync_generation_id`, `target_sync_generation_id` ON `sync_connect_generation_attempt`
FOR EACH ROW
WHEN NEW.`attempt_id` IS NOT OLD.`attempt_id`
  OR NEW.`source_sync_generation_id` IS NOT OLD.`source_sync_generation_id`
  OR NEW.`target_sync_generation_id` IS NOT OLD.`target_sync_generation_id`
BEGIN
  SELECT RAISE(ABORT, 'sync connect generation identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_connect_generation_attempt_activation_guard`
BEFORE UPDATE OF `state`, `activation_receipt`, `activated_at` ON `sync_connect_generation_attempt`
FOR EACH ROW
WHEN NEW.`state` = 'activated' AND NOT EXISTS (
  SELECT 1
  FROM `sync_connect_attempt` AS `attempt`
  JOIN `sync_generation` AS `source_generation`
    ON `source_generation`.`sync_generation_id` = NEW.`source_sync_generation_id`
  LEFT JOIN `sync_generation` AS `target_generation`
    ON `target_generation`.`sync_generation_id` = NEW.`target_sync_generation_id`
  WHERE `attempt`.`attempt_id` = NEW.`attempt_id`
    AND `attempt`.`state` NOT IN ('completed', 'failed', 'cancelled')
    AND NEW.`activation_receipt` IS NOT NULL
    AND NEW.`activated_at` IS NOT NULL
    AND (
      `attempt`.`target_mode` = 'local'
      OR NEW.`commit_marker_object_id` IS NOT NULL
    )
    AND (
      (
        NEW.`target_sync_generation_id` IS NULL
        AND `source_generation`.`status` = 'active'
      )
      OR (
        NEW.`target_sync_generation_id` IS NOT NULL
        AND `source_generation`.`status` = 'retired'
        AND `source_generation`.`retired_at` IS NOT NULL
        AND `target_generation`.`status` = 'active'
        AND `target_generation`.`project_sync_id` = `source_generation`.`project_sync_id`
        AND `target_generation`.`generation_number` = `source_generation`.`generation_number` + 1
        AND `target_generation`.`project_id` IS `source_generation`.`project_id`
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'sync generation activation is not durable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_connect_generation_attempt_activated_immutable`
BEFORE UPDATE ON `sync_connect_generation_attempt`
FOR EACH ROW
WHEN OLD.`state` = 'activated'
BEGIN
  SELECT RAISE(ABORT, 'activated sync connect generation attempt is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_connect_generation_attempt_no_delete`
BEFORE DELETE ON `sync_connect_generation_attempt`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'sync connect generation activation receipt cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_generation_project_identity_guard`
BEFORE UPDATE OF `project_id`, `project_sync_id`, `generation_number` ON `sync_generation`
FOR EACH ROW
WHEN (
  NEW.`project_sync_id` IS NOT OLD.`project_sync_id`
  OR NEW.`generation_number` <> OLD.`generation_number`
  OR (
    OLD.`project_id` IS NOT NULL
    AND NEW.`project_id` IS NOT NULL
    AND NEW.`project_id` IS NOT OLD.`project_id`
  )
)
AND NOT (
  OLD.`status` = 'staged'
  AND OLD.`project_id` IS NULL
  AND NEW.`project_id` IS NULL
  AND OLD.`project_sync_id` = 'restore-pending:' || OLD.`sync_generation_id`
  AND NEW.`project_sync_id` <> OLD.`project_sync_id`
  AND NEW.`generation_number` >= 1
)
BEGIN
  SELECT RAISE(ABORT, 'sync generation identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_generation_no_delete`
BEFORE DELETE ON `sync_generation`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'sync generation history cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_change_set_immutable_fields`
BEFORE UPDATE ON `sync_change_set`
FOR EACH ROW
WHEN
  NEW.`change_set_id` IS NOT OLD.`change_set_id`
  OR NEW.`sync_generation_id` IS NOT OLD.`sync_generation_id`
  OR NEW.`project_id` IS NOT OLD.`project_id`
  OR NEW.`project_sync_id` IS NOT OLD.`project_sync_id`
  OR NEW.`writer_id` IS NOT OLD.`writer_id`
  OR NEW.`writer_epoch` IS NOT OLD.`writer_epoch`
  OR NEW.`device_seq` IS NOT OLD.`device_seq`
  OR NEW.`hlc_wall_ms` IS NOT OLD.`hlc_wall_ms`
  OR NEW.`hlc_counter` IS NOT OLD.`hlc_counter`
  OR NEW.`protocol_version` IS NOT OLD.`protocol_version`
  OR NEW.`payload_version` IS NOT OLD.`payload_version`
  OR NEW.`mutation_count` IS NOT OLD.`mutation_count`
  OR NEW.`encoded_bytes` IS NOT OLD.`encoded_bytes`
  OR NEW.`payload_sha256` IS NOT OLD.`payload_sha256`
  OR NEW.`origin` IS NOT OLD.`origin`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'sync change set payload is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_change_set_no_delete`
BEFORE DELETE ON `sync_change_set`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'sync change set cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_mutation_index_bounds`
BEFORE INSERT ON `sync_mutation`
FOR EACH ROW
WHEN NEW.`mutation_index` >= (
  SELECT `mutation_count`
  FROM `sync_change_set`
  WHERE `change_set_id` = NEW.`change_set_id`
)
BEGIN
  SELECT RAISE(ABORT, 'sync mutation index exceeds change set size');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_mutation_immutable_update`
BEFORE UPDATE ON `sync_mutation`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'sync mutation is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_mutation_no_delete`
BEFORE DELETE ON `sync_mutation`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'sync mutation cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_apply_receipt_complete_change_set`
BEFORE INSERT ON `sync_apply_receipt`
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM `sync_change_set` AS `change_set`
  WHERE `change_set`.`change_set_id` = NEW.`change_set_id`
    AND `change_set`.`sync_generation_id` = NEW.`sync_generation_id`
    AND `change_set`.`mutation_count` = NEW.`mutation_count`
    AND (
      SELECT count(*)
      FROM `sync_mutation` AS `mutation`
      WHERE `mutation`.`change_set_id` = NEW.`change_set_id`
    ) = `change_set`.`mutation_count`
    AND (
      SELECT min(`mutation_index`)
      FROM `sync_mutation` AS `mutation`
      WHERE `mutation`.`change_set_id` = NEW.`change_set_id`
    ) = 0
    AND (
      SELECT max(`mutation_index`)
      FROM `sync_mutation` AS `mutation`
      WHERE `mutation`.`change_set_id` = NEW.`change_set_id`
    ) = `change_set`.`mutation_count` - 1
)
BEGIN
  SELECT RAISE(ABORT, 'sync apply receipt requires a complete change set');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_apply_receipt_immutable_update`
BEFORE UPDATE ON `sync_apply_receipt`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'sync apply receipt is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_sync_apply_receipt_no_delete`
BEFORE DELETE ON `sync_apply_receipt`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'sync apply receipt cannot be deleted');
END;
--> statement-breakpoint
