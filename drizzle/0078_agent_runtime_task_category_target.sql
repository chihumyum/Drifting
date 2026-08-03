-- Long-task provider contracts have always allowed category targets, but the
-- original SQLite CHECK constraint omitted `category`. Rebuild the step table
-- so a model-authored cleanup plan can durably target a category/directory.

DROP TABLE IF EXISTS `agent_runtime_task_step_next`;
--> statement-breakpoint
CREATE TABLE `agent_runtime_task_step_next` (
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
	`id`, `task_id`, `project_id`, `session_id`, `ordinal`, `title`,
	`target_kind`, `target_name`, `resolved_target_id`, `status`,
	`result_note`, `result_ref`, `review_result_json`, `created_at`, `updated_at`,
	`started_at`, `completed_at`
)
SELECT
	`id`, `task_id`, `project_id`, `session_id`, `ordinal`, `title`,
	`target_kind`, `target_name`, `resolved_target_id`, `status`,
	`result_note`, `result_ref`, `review_result_json`, `created_at`, `updated_at`,
	`started_at`, `completed_at`
FROM `agent_runtime_task_step`;
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
