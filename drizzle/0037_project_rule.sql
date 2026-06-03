CREATE TABLE `project_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`raw_content` text DEFAULT '' NOT NULL,
	`checklist_json` text DEFAULT '[]' NOT NULL,
	`compiled_from_hash` text DEFAULT '' NOT NULL,
	`severity` text DEFAULT 'soft' NOT NULL,
	`scope_json` text,
	`enabled` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'project' NOT NULL,
	`source_drift_id` text,
	`source_drift_hash` text,
	`order_key` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
