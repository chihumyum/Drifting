ALTER TABLE `agent_runtime_task` ADD `work_kind` text DEFAULT 'edit' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_runtime_task_step` ADD `review_result_json` text;
