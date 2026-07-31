-- Durable long-task plan for work that spans several Agent budget slices or
-- renderer restarts. The authored novel remains in its domain tables/Yjs;
-- these rows store only runtime orchestration state.

CREATE TABLE `agent_runtime_task` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`objective` text NOT NULL,
	`scope_kind` text DEFAULT 'explicit_targets' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`session_id`,`project_id`)
		REFERENCES `agent_runtime_session`(`id`,`project_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (length(`objective`) > 0),
	CHECK (`scope_kind` IN ('explicit_targets', 'whole_book_chapters')),
	CHECK (`status` IN ('active', 'paused', 'blocked', 'completed', 'failed')),
	CHECK (`revision` >= 0),
	CHECK (
		(`status` IN ('completed', 'failed') AND `ended_at` IS NOT NULL)
		OR
		(`status` IN ('active', 'paused', 'blocked') AND `ended_at` IS NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_scope_identity`
	ON `agent_runtime_task` (`id`,`project_id`,`session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_open_session`
	ON `agent_runtime_task` (`project_id`,`session_id`)
	WHERE `status` IN ('active', 'paused', 'blocked');
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_task_scope_status`
	ON `agent_runtime_task` (`project_id`,`session_id`,`status`,`updated_at`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_task_chapter_manifest` (
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`name` text NOT NULL,
	`resolved_chapter_id` text NOT NULL,
	PRIMARY KEY (`task_id`,`ordinal`),
	FOREIGN KEY (`task_id`,`project_id`,`session_id`)
		REFERENCES `agent_runtime_task`(`id`,`project_id`,`session_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`ordinal` >= 0),
	CHECK (length(`name`) > 0),
	CHECK (length(`resolved_chapter_id`) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_manifest_chapter`
	ON `agent_runtime_task_chapter_manifest` (`task_id`,`resolved_chapter_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_task_manifest_scope`
	ON `agent_runtime_task_chapter_manifest`
	(`project_id`,`session_id`,`task_id`,`ordinal`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_task_step` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`target_kind` text,
	`target_name` text,
	`resolved_target_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_note` text,
	`result_ref` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`task_id`,`project_id`,`session_id`)
		REFERENCES `agent_runtime_task`(`id`,`project_id`,`session_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`ordinal` >= 0),
	CHECK (length(`title`) > 0),
	CHECK (`target_kind` IS NULL OR `target_kind` IN (
		'book',
		'project',
		'chapter',
		'drift',
		'element',
		'storyline',
		'other'
	)),
	CHECK (
		(`target_kind` IS NULL AND `target_name` IS NULL AND `resolved_target_id` IS NULL)
		OR
		(`target_kind` IS NOT NULL AND `target_name` IS NOT NULL AND length(`target_name`) > 0)
	),
	CHECK (`status` IN ('pending', 'in_progress', 'blocked', 'completed', 'failed')),
	CHECK (
		(`status` IN ('completed', 'failed') AND `completed_at` IS NOT NULL)
		OR
		(`status` IN ('pending', 'in_progress', 'blocked') AND `completed_at` IS NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_step_ordinal`
	ON `agent_runtime_task_step` (`task_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_step_scope_identity`
	ON `agent_runtime_task_step` (`id`,`task_id`,`project_id`,`session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_step_in_progress`
	ON `agent_runtime_task_step` (`task_id`)
	WHERE `status` = 'in_progress';
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_task_step_status`
	ON `agent_runtime_task_step` (`task_id`,`status`,`ordinal`);
--> statement-breakpoint

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
	FOREIGN KEY (`task_id`,`project_id`,`session_id`)
		REFERENCES `agent_runtime_task`(`id`,`project_id`,`session_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (
		`superseded_by_id`,
		`task_id`,
		`project_id`,
		`session_id`
	)
		REFERENCES `agent_runtime_task_constraint`(
			`id`,
			`task_id`,
			`project_id`,
			`session_id`
		)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (length(`body`) > 0),
	CHECK (`source` IN ('author', 'agent', 'runtime')),
	CHECK (`status` IN ('active', 'superseded', 'fulfilled')),
	CHECK (
		(`status` = 'active' AND `settled_at` IS NULL AND `superseded_by_id` IS NULL)
		OR
		(`status` = 'fulfilled' AND `settled_at` IS NOT NULL AND `superseded_by_id` IS NULL)
		OR
		(`status` = 'superseded' AND `settled_at` IS NOT NULL AND `superseded_by_id` IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_constraint_scope_identity`
	ON `agent_runtime_task_constraint` (`id`,`task_id`,`project_id`,`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_task_constraint_status`
	ON `agent_runtime_task_constraint` (`task_id`,`status`,`created_at`);
--> statement-breakpoint

-- The command row is the crash-safe, exactly-once receipt for runtime-virtual
-- plan writes. It intentionally does not enter authored-write review.
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
	FOREIGN KEY (`task_id`,`project_id`,`session_id`)
		REFERENCES `agent_runtime_task`(`id`,`project_id`,`session_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (`turn_id`,`session_id`)
		REFERENCES `agent_runtime_turn`(`id`,`session_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (
		`tool_call_id`,
		`session_id`,
		`turn_id`,
		`call_id`,
		`idempotency_key`,
		`tool_access`,
		`tool_name`
	)
		REFERENCES `agent_runtime_tool_call`(
			`id`,
			`session_id`,
			`turn_id`,
			`call_id`,
			`idempotency_key`,
			`access`,
			`name`
		)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`tool_name` IN (
		'update_task_plan',
		'update_task_step',
		'update_task_constraint'
	)),
	CHECK (`tool_access` = 'write'),
	CHECK (length(`arguments_hash`) = 71),
	CHECK (substr(`arguments_hash`, 1, 7) = 'sha256:'),
	CHECK (substr(`arguments_hash`, 8) NOT GLOB '*[^0-9a-f]*'),
	CHECK (length(`result_json`) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_task_command_call`
	ON `agent_runtime_task_command` (`turn_id`,`call_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_task_command_task`
	ON `agent_runtime_task_command` (`task_id`,`created_at`);
