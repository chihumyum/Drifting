ALTER TABLE `project_rule` ADD COLUMN `kind` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `project_rule` ADD COLUMN `judging_guide` text DEFAULT '' NOT NULL;