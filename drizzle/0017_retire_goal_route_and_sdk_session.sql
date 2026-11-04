-- Retire the Goal Agent route and the Claude SDK session pointer.
--
-- Goal Evolve was retired on 2026-08-05, before the first public release, so
-- every General Agent runtime session belongs to a chat conversation. The
-- `goal_run_id` and `chapter_id` route columns of `agent_runtime_session` and
-- `agent_runtime_write_effect`, and the Goal branch of the session route CHECK,
-- are dropped. `agent_conversation.sdk_session_id` belonged to the removed
-- Claude SDK runtime; the provider-neutral runtime never reads or writes it.
--
-- `agent_runtime_session` is rebuilt because its CHECK and an index name the
-- retired columns. Every row is copied: a Goal session would violate the new
-- CHECK and abort the migration, leaving the source database untouched, rather
-- than being discarded silently. The route-provenance triggers and the chat
-- queue trigger name the rebuilt table or the dropped columns, so they are
-- dropped first and recreated afterwards with the same behaviour minus the
-- Goal columns. The native migrator runs with foreign keys off, so dropping the
-- old table cascades nothing; child tables keep their rows and references. The
-- new CHECK names its columns unqualified: a CHECK qualified with the temporary
-- table name stops resolving once the table is renamed.
DROP TRIGGER `trg_agent_runtime_write_effect_route_insert`;
--> statement-breakpoint
DROP TRIGGER `trg_agent_runtime_write_effect_route_update`;
--> statement-breakpoint
DROP TRIGGER `trg_agent_runtime_session_effect_route_update`;
--> statement-breakpoint
DROP TRIGGER agent_chat_queue_terminal;
--> statement-breakpoint
CREATE TABLE `__new_agent_runtime_session` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`route_kind` text NOT NULL,
	`conversation_id` text,
	`provider` text NOT NULL,
	`model` text,
	`provider_epoch` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_runtime_session_route_shape_check" CHECK(`route_kind` = 'chat' and `conversation_id` is not null)
);
--> statement-breakpoint
INSERT INTO `__new_agent_runtime_session`("id", "project_id", "route_kind", "conversation_id", "provider", "model", "provider_epoch", "status", "created_at", "updated_at", "ended_at") SELECT "id", "project_id", "route_kind", "conversation_id", "provider", "model", "provider_epoch", "status", "created_at", "updated_at", "ended_at" FROM `agent_runtime_session`;
--> statement-breakpoint
DROP TABLE `agent_runtime_session`;
--> statement-breakpoint
ALTER TABLE `__new_agent_runtime_session` RENAME TO `agent_runtime_session`;
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_project` ON `agent_runtime_session` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_conversation` ON `agent_runtime_session` (`conversation_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_session_recovery` ON `agent_runtime_session` (`project_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_session_project_identity` ON `agent_runtime_session` (`id`,`project_id`);
--> statement-breakpoint
ALTER TABLE `agent_conversation` DROP COLUMN `sdk_session_id`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_effect` DROP COLUMN `goal_run_id`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_write_effect` DROP COLUMN `chapter_id`;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_write_effect_route_insert`
BEFORE INSERT ON `agent_runtime_write_effect`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_session` AS `session`
	WHERE `session`.`id` = NEW.`session_id`
		AND `session`.`project_id` = NEW.`project_id`
		AND `session`.`route_kind` = NEW.`route_kind`
		AND `session`.`conversation_id` IS NEW.`conversation_id`
)
BEGIN
	SELECT RAISE(ABORT, 'agent write effect route provenance mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_write_effect_route_update`
BEFORE UPDATE OF
	`project_id`,
	`route_kind`,
	`conversation_id`,
	`session_id`
ON `agent_runtime_write_effect`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_session` AS `session`
	WHERE `session`.`id` = NEW.`session_id`
		AND `session`.`project_id` = NEW.`project_id`
		AND `session`.`route_kind` = NEW.`route_kind`
		AND `session`.`conversation_id` IS NEW.`conversation_id`
)
BEGIN
	SELECT RAISE(ABORT, 'agent write effect route provenance mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_session_effect_route_update`
BEFORE UPDATE OF
	`project_id`,
	`route_kind`,
	`conversation_id`
ON `agent_runtime_session`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `agent_runtime_write_effect` AS `effect`
	WHERE `effect`.`session_id` = OLD.`id`
		AND (
			`effect`.`project_id` <> NEW.`project_id`
			OR `effect`.`route_kind` <> NEW.`route_kind`
			OR `effect`.`conversation_id` IS NOT NEW.`conversation_id`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'agent runtime session route has durable write effects');
END;
--> statement-breakpoint
CREATE TRIGGER agent_chat_queue_terminal AFTER UPDATE OF status ON agent_runtime_turn
WHEN NEW.status IN ('completed', 'failed', 'aborted', 'interrupted') BEGIN
  INSERT INTO agent_chat_queue(conversation_id, revision)
  SELECT session.conversation_id, 1 FROM agent_runtime_session AS session
  JOIN agent_conversation AS conversation ON conversation.id = session.conversation_id
  WHERE session.id = NEW.session_id AND conversation.source = 'chat'
  ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
END;
