-- Durable, content-addressed storage for oversized Agent tool results.
--
-- Provider context only receives a bounded preview and an opaque resultRef.
-- The complete UTF-8 bytes remain local, carry exact runtime provenance, and
-- survive renderer/app restart until explicit age/quota garbage collection.

CREATE TABLE `agent_runtime_result_blob` (
	`content_hash` text PRIMARY KEY NOT NULL,
	`content_blob` blob NOT NULL,
	`byte_count` integer NOT NULL,
	`char_count` integer NOT NULL,
	`created_at` text NOT NULL,
	CHECK (
		length(`content_hash`) = 71
		AND substr(`content_hash`, 1, 7) = 'sha256:'
		AND substr(`content_hash`, 8) NOT GLOB '*[^0-9a-f]*'
	),
	CHECK (`byte_count` > 0),
	CHECK (`byte_count` = length(`content_blob`)),
	CHECK (`char_count` > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_result_blob_created`
	ON `agent_runtime_result_blob` (`created_at`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_result_artifact` (
	`ref` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_access` text DEFAULT 'read' NOT NULL,
	`idempotency_key` text NOT NULL,
	`arguments_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`content_hash`)
		REFERENCES `agent_runtime_result_blob`(`content_hash`)
		ON UPDATE NO ACTION ON DELETE NO ACTION,
	FOREIGN KEY (`session_id`,`project_id`)
		REFERENCES `agent_runtime_session`(`id`,`project_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (`turn_id`,`session_id`)
		REFERENCES `agent_runtime_turn`(`id`,`session_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (
		`tool_call_id`,
		`session_id`,
		`turn_id`,
		`call_id`,
		`idempotency_key`,
		`tool_access`,
		`tool_name`
	) REFERENCES `agent_runtime_tool_call`(
		`id`,
		`session_id`,
		`turn_id`,
		`call_id`,
		`idempotency_key`,
		`access`,
		`name`
	) ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (length(`ref`) > 0),
	CHECK (length(`project_id`) > 0),
	CHECK (length(`call_id`) > 0),
	CHECK (length(`tool_name`) > 0),
	CHECK (`tool_access` = 'read'),
	CHECK (length(`idempotency_key`) > 0),
	CHECK (length(`arguments_json`) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_result_artifact_tool_call`
	ON `agent_runtime_result_artifact` (`tool_call_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_result_artifact_provenance`
	ON `agent_runtime_result_artifact`
		(`ref`,`project_id`,`session_id`,`turn_id`,`tool_call_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_result_artifact_session_created`
	ON `agent_runtime_result_artifact`
		(`project_id`,`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_result_artifact_content`
	ON `agent_runtime_result_artifact` (`content_hash`);
--> statement-breakpoint

CREATE TRIGGER `trg_agent_runtime_result_blob_immutable`
BEFORE UPDATE ON `agent_runtime_result_blob`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent result blob is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_result_artifact_immutable`
BEFORE UPDATE ON `agent_runtime_result_artifact`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent result artifact is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_result_artifact_delete_orphan`
AFTER DELETE ON `agent_runtime_result_artifact`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_result_artifact`
	WHERE `content_hash` = OLD.`content_hash`
)
BEGIN
	DELETE FROM `agent_runtime_result_blob`
	WHERE `content_hash` = OLD.`content_hash`;
END;
