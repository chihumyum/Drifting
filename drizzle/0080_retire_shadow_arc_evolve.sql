UPDATE `book_node`
SET `writing_status` = 'draft'
WHERE `writing_status` IN ('waiting_review', 'revising');
--> statement-breakpoint
UPDATE `comment`
SET `source` = 'api'
WHERE `source` = 'shadow';
--> statement-breakpoint
DROP TABLE IF EXISTS `element_arc`;
--> statement-breakpoint
DROP TABLE IF EXISTS `shadow_job`;
--> statement-breakpoint
DROP TABLE IF EXISTS `project_rule`;
--> statement-breakpoint
DROP TABLE IF EXISTS `ai_usage`;
