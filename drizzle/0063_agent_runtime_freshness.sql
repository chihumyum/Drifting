-- Provider-neutral durable read observations and write freshness guards.
--
-- A provider tool result is not a safe concurrency token by itself. Keep the
-- exact canonical result bytes and every entity version observed while
-- producing it, then bind write effects to those immutable observations.
-- The renderer repository validates the bindings and executes the eventual
-- mutation in one BEGIN IMMEDIATE transaction.

CREATE TABLE `agent_runtime_read_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_access` text DEFAULT 'read' NOT NULL,
	`idempotency_key` text NOT NULL,
	`result_blob` blob NOT NULL,
	`result_hash` text NOT NULL,
	`created_at` text NOT NULL,
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
	CHECK (`tool_access` = 'read'),
	CHECK (length(`call_id`) > 0),
	CHECK (length(`tool_name`) > 0),
	CHECK (length(`idempotency_key`) > 0),
	CHECK (length(`result_blob`) > 0),
	CHECK (
		length(`result_hash`) = 71
		AND substr(`result_hash`, 1, 7) = 'sha256:'
		AND substr(`result_hash`, 8) NOT GLOB '*[^0-9a-f]*'
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_receipt_tool_call`
	ON `agent_runtime_read_receipt` (`tool_call_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_receipt_idempotency`
	ON `agent_runtime_read_receipt` (`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_receipt_provenance`
	ON `agent_runtime_read_receipt`
		(`id`,`project_id`,`session_id`,`turn_id`,`tool_call_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_read_receipt_session_created`
	ON `agent_runtime_read_receipt` (`session_id`,`created_at`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_read_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`revision` text NOT NULL,
	`state_vector` blob,
	`state_hash` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (
		`receipt_id`,
		`project_id`,
		`session_id`,
		`turn_id`,
		`tool_call_id`
	) REFERENCES `agent_runtime_read_receipt`(
		`id`,
		`project_id`,
		`session_id`,
		`turn_id`,
		`tool_call_id`
	) ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`ordinal` >= 0),
	CHECK (length(`entity_kind`) > 0),
	CHECK (length(`entity_id`) > 0),
	CHECK (length(`revision`) > 0),
	CHECK (`state_vector` IS NULL OR length(`state_vector`) > 0),
	CHECK (
		`state_hash` IS NULL
		OR (
			length(`state_hash`) = 71
			AND substr(`state_hash`, 1, 7) = 'sha256:'
			AND substr(`state_hash`, 8) NOT GLOB '*[^0-9a-f]*'
		)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_observation_ordinal`
	ON `agent_runtime_read_observation` (`receipt_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_observation_entity`
	ON `agent_runtime_read_observation`
		(`receipt_id`,`entity_kind`,`entity_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_read_observation_provenance`
	ON `agent_runtime_read_observation` (
		`id`,
		`receipt_id`,
		`project_id`,
		`session_id`,
		`turn_id`,
		`tool_call_id`,
		`entity_kind`,
		`entity_id`,
		`revision`
	);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_read_observation_entity_revision`
	ON `agent_runtime_read_observation`
		(`project_id`,`entity_kind`,`entity_id`,`revision`);
--> statement-breakpoint

CREATE UNIQUE INDEX `uniq_agent_runtime_write_effect_freshness_provenance`
	ON `agent_runtime_write_effect`
		(`id`,`project_id`,`session_id`,`turn_id`,`tool_call_id`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_write_expectation` (
	`id` text PRIMARY KEY NOT NULL,
	`effect_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`write_turn_id` text NOT NULL,
	`write_tool_call_id` text NOT NULL,
	`observation_id` text NOT NULL,
	`read_receipt_id` text NOT NULL,
	`read_turn_id` text NOT NULL,
	`read_tool_call_id` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`expected_revision` text NOT NULL,
	`expected_state_vector` blob,
	`expected_state_hash` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (
		`effect_id`,
		`project_id`,
		`session_id`,
		`write_turn_id`,
		`write_tool_call_id`
	) REFERENCES `agent_runtime_write_effect`(
		`id`,
		`project_id`,
		`session_id`,
		`turn_id`,
		`tool_call_id`
	) ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (
		`observation_id`,
		`read_receipt_id`,
		`project_id`,
		`session_id`,
		`read_turn_id`,
		`read_tool_call_id`,
		`entity_kind`,
		`entity_id`,
		`expected_revision`
	) REFERENCES `agent_runtime_read_observation`(
		`id`,
		`receipt_id`,
		`project_id`,
		`session_id`,
		`turn_id`,
		`tool_call_id`,
		`entity_kind`,
		`entity_id`,
		`revision`
	) ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (length(`entity_kind`) > 0),
	CHECK (length(`entity_id`) > 0),
	CHECK (length(`expected_revision`) > 0),
	CHECK (
		`read_turn_id` <> `write_turn_id`
		OR `read_tool_call_id` <> `write_tool_call_id`
	),
	CHECK (
		`expected_state_vector` IS NULL
		OR length(`expected_state_vector`) > 0
	),
	CHECK (
		`expected_state_hash` IS NULL
		OR (
			length(`expected_state_hash`) = 71
			AND substr(`expected_state_hash`, 1, 7) = 'sha256:'
			AND substr(`expected_state_hash`, 8) NOT GLOB '*[^0-9a-f]*'
		)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_expectation_observation`
	ON `agent_runtime_write_expectation` (`effect_id`,`observation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_expectation_entity`
	ON `agent_runtime_write_expectation`
		(`effect_id`,`entity_kind`,`entity_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_write_expectation_effect`
	ON `agent_runtime_write_expectation` (`effect_id`);
--> statement-breakpoint

CREATE TRIGGER `trg_agent_runtime_read_receipt_immutable`
BEFORE UPDATE ON `agent_runtime_read_receipt`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent read receipt is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_read_observation_immutable`
BEFORE UPDATE ON `agent_runtime_read_observation`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent read observation is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_write_expectation_exact_insert`
BEFORE INSERT ON `agent_runtime_write_expectation`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_read_observation` AS `observation`
	WHERE `observation`.`id` = NEW.`observation_id`
		AND `observation`.`receipt_id` = NEW.`read_receipt_id`
		AND `observation`.`project_id` = NEW.`project_id`
		AND `observation`.`session_id` = NEW.`session_id`
		AND `observation`.`turn_id` = NEW.`read_turn_id`
		AND `observation`.`tool_call_id` = NEW.`read_tool_call_id`
		AND `observation`.`entity_kind` = NEW.`entity_kind`
		AND `observation`.`entity_id` = NEW.`entity_id`
		AND `observation`.`revision` = NEW.`expected_revision`
		AND `observation`.`state_vector` IS NEW.`expected_state_vector`
		AND `observation`.`state_hash` IS NEW.`expected_state_hash`
)
BEGIN
	SELECT RAISE(ABORT, 'agent write expectation drifted from read observation');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_write_expectation_immutable`
BEFORE UPDATE ON `agent_runtime_write_expectation`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent write expectation is immutable');
END;
