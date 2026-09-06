CREATE TABLE `agent_chat_binding` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`local_owner` integer NOT NULL,
	`session_id` text,
	`exported_ordinal` integer DEFAULT -1 NOT NULL,
	`seeded_through` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_chat_branch` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`root_id` text NOT NULL,
	`parent_branch_id` text,
	`fork_turn_id` text,
	`head_turn_id` text,
	`title` text NOT NULL,
	`title_clock` text NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`readiness` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_chat_branch_project` ON `agent_chat_branch` (`project_id`);--> statement-breakpoint
CREATE TABLE `agent_chat_cursor` (
	`id` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`backfill_complete` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_chat_delivery` (
	`scope_id` text NOT NULL,
	`object_id` text NOT NULL,
	`remote_id` text,
	`state` text NOT NULL,
	`detail` text,
	PRIMARY KEY(`scope_id`, `object_id`)
);
--> statement-breakpoint
CREATE TABLE `agent_chat_object` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`branch_id` text,
	`kind` text NOT NULL,
	`body_json` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_chat_object_project` ON `agent_chat_object` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_chat_object_branch` ON `agent_chat_object` (`branch_id`);--> statement-breakpoint
CREATE TABLE `agent_chat_queue` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TRIGGER agent_chat_queue_conversation_insert AFTER INSERT ON agent_conversation BEGIN
  INSERT INTO agent_chat_queue(conversation_id, revision) VALUES (NEW.id, 1)
  ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER agent_chat_queue_conversation_update AFTER UPDATE ON agent_conversation BEGIN
  INSERT INTO agent_chat_queue(conversation_id, revision) VALUES (NEW.id, 1)
  ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER agent_chat_queue_terminal AFTER UPDATE OF status ON agent_runtime_turn
WHEN NEW.status IN ('completed', 'failed', 'aborted', 'interrupted') BEGIN
  INSERT INTO agent_chat_queue(conversation_id, revision)
  SELECT conversation_id, 1 FROM agent_runtime_session
  WHERE id = NEW.session_id AND conversation_id IS NOT NULL
  ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
END;
