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
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CHECK (`transport` IN ('stdio', 'streamable_http')),
	CHECK (`health_status` IN ('disabled', 'connecting', 'healthy', 'degraded', 'failed')),
	CHECK ((`transport` = 'stdio' AND `command` IS NOT NULL AND `url` IS NULL) OR (`transport` = 'streamable_http' AND `url` IS NOT NULL AND `command` IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_mcp_server_project_name`
	ON `agent_mcp_server` (`project_id`, `name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_mcp_server_scope_identity`
	ON `agent_mcp_server` (`id`, `project_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_mcp_server_project_enabled`
	ON `agent_mcp_server` (`project_id`, `enabled`);
--> statement-breakpoint
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
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CHECK (`scope` IN ('session', 'project')),
	CHECK (`source_kind` IN ('mcp', 'plugin')),
	CHECK (`access` IN ('read', 'write')),
	CHECK (`status` IN ('active', 'revoked')),
	CHECK ((`scope` = 'session' AND `session_id` IS NOT NULL) OR (`scope` = 'project' AND `session_id` IS NULL)),
	CHECK (`arguments_hash` GLOB 'sha256:*')
);
--> statement-breakpoint
CREATE INDEX `idx_agent_permission_grant_match`
	ON `agent_permission_grant` (`project_id`, `source_kind`, `source_id`, `provider_tool_name`, `arguments_hash`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_agent_permission_grant_project_status`
	ON `agent_permission_grant` (`project_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `idx_agent_permission_grant_session`
	ON `agent_permission_grant` (`session_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_permission_grant_active`
	ON `agent_permission_grant` (`project_id`, ifnull(`session_id`, ''), `scope`, `source_kind`, `source_id`, `provider_tool_name`, `remote_tool_name`, `access`, `arguments_hash`, `tool_definition_revision`, `source_config_revision`)
	WHERE `status` = 'active';
