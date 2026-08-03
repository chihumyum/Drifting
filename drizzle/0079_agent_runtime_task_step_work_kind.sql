-- A complex durable task may legitimately alternate between discovery,
-- effect-producing edits, and exact-source review. Persist the evidence kind
-- on each step so preparatory research is not forced to manufacture a write.

DROP TABLE IF EXISTS `agent_runtime_task_step_next`;
--> statement-breakpoint
CREATE TABLE `agent_runtime_task_step_next` (
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
	FOREIGN KEY (`task_id`,`project_id`,`session_id`)
		REFERENCES `agent_runtime_task`(`id`,`project_id`,`session_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`ordinal` >= 0),
	CHECK (length(`title`) > 0),
	CHECK (`work_kind` IN ('edit', 'review', 'research')),
	CHECK (`target_kind` IS NULL OR `target_kind` IN (
		'book',
		'project',
		'chapter',
		'drift',
		'element',
		'storyline',
		'category',
		'other'
	)),
	CHECK (
		(`target_kind` IS NULL AND `target_name` IS NULL AND `resolved_target_id` IS NULL)
		OR
		(`target_kind` IS NOT NULL AND `target_name` IS NOT NULL AND length(`target_name`) > 0)
	),
	CHECK (`status` IN ('pending', 'in_progress', 'blocked', 'completed', 'failed', 'retired')),
	CHECK (
		(`status` IN ('completed', 'failed', 'retired') AND `completed_at` IS NOT NULL)
		OR
		(`status` IN ('pending', 'in_progress', 'blocked') AND `completed_at` IS NULL)
	)
);
--> statement-breakpoint
INSERT INTO `agent_runtime_task_step_next` (
	`id`, `task_id`, `project_id`, `session_id`, `ordinal`, `title`, `work_kind`,
	`target_kind`, `target_name`, `resolved_target_id`, `status`,
	`result_note`, `result_ref`, `review_result_json`, `created_at`, `updated_at`,
	`started_at`, `completed_at`
)
SELECT
	s.`id`, s.`task_id`, s.`project_id`, s.`session_id`, s.`ordinal`, s.`title`,
	COALESCE(t.`work_kind`, 'edit'),
	s.`target_kind`, s.`target_name`, s.`resolved_target_id`, s.`status`,
	s.`result_note`, s.`result_ref`, s.`review_result_json`, s.`created_at`, s.`updated_at`,
	s.`started_at`, s.`completed_at`
FROM `agent_runtime_task_step` AS s
INNER JOIN `agent_runtime_task` AS t ON t.`id` = s.`task_id`;
--> statement-breakpoint
DROP TABLE `agent_runtime_task_step`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_task_step_next` RENAME TO `agent_runtime_task_step`;
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
