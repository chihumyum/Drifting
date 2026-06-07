-- Element Arc — per-element derived development trajectory (the「弧线透镜」).
--
-- A dedicated table joined to `element`, NOT shoehorned into shadow_job: shadow_job
-- is a chapter-CI record (subject = chapter, product = findings/comments), while an
-- arc is an element-level analysis (subject = element, product = an ArcMap). One row
-- per element holds the latest derivation + its status, so the element editor's arc
-- section persists across reloads. result_json holds the ArcMap (null until done).

CREATE TABLE `element_arc` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`element_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`include_drafts` integer DEFAULT 0 NOT NULL,
	`result_json` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `element`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_element_arc_element` ON `element_arc` (`element_id`);
