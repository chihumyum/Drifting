ALTER TABLE `agent_conversation` ADD `source` text DEFAULT 'chat' NOT NULL;
--> statement-breakpoint
DROP TRIGGER agent_chat_queue_conversation_insert;
--> statement-breakpoint
DROP TRIGGER agent_chat_queue_conversation_update;
--> statement-breakpoint
DROP TRIGGER agent_chat_queue_terminal;
--> statement-breakpoint
CREATE TRIGGER agent_chat_queue_conversation_insert AFTER INSERT ON agent_conversation
WHEN NEW.source = 'chat' BEGIN
  INSERT INTO agent_chat_queue(conversation_id, revision) VALUES (NEW.id, 1)
  ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
END;
--> statement-breakpoint
CREATE TRIGGER agent_chat_queue_conversation_update AFTER UPDATE ON agent_conversation
WHEN NEW.source = 'chat' BEGIN
  INSERT INTO agent_chat_queue(conversation_id, revision) VALUES (NEW.id, 1)
  ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1;
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
--> statement-breakpoint
-- Preserve external audit/review identities, including sessions previously
-- continued under another provider and projections synced without runtime rows.
UPDATE agent_conversation SET source = 'external_mcp'
WHERE id GLOB 'mcp:*:conversation'
   OR runtime_session_id GLOB 'mcp:*'
   OR EXISTS (
     SELECT 1 FROM agent_runtime_session AS session
     WHERE session.conversation_id = agent_conversation.id
       AND session.project_id = agent_conversation.project_id
       AND session.provider = 'mcp'
   );
--> statement-breakpoint
UPDATE agent_conversation SET source = 'external_mcp'
WHERE id IN (
  SELECT branch.id FROM agent_chat_branch AS branch
  WHERE branch.root_id GLOB 'mcp:*:conversation'
     OR branch.root_id IN (SELECT id FROM agent_conversation WHERE source = 'external_mcp')
);
--> statement-breakpoint
DELETE FROM agent_chat_queue
WHERE conversation_id IN (SELECT id FROM agent_conversation WHERE source = 'external_mcp');
