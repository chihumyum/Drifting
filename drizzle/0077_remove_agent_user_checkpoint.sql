DROP TABLE IF EXISTS `agent_user_checkpoint_action_entity`;
--> statement-breakpoint
DROP TABLE IF EXISTS `agent_user_checkpoint_action`;
--> statement-breakpoint
DROP TABLE IF EXISTS `agent_user_checkpoint_entity`;
--> statement-breakpoint
DROP TABLE IF EXISTS `agent_user_checkpoint`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_agent_conversation_fork_checkpoint`;
--> statement-breakpoint
ALTER TABLE `agent_conversation` DROP COLUMN `fork_checkpoint_id`;
--> statement-breakpoint
ALTER TABLE `agent_conversation` DROP COLUMN `parent_conversation_id`;
