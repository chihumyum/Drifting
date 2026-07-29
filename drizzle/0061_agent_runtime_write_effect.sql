-- Canonical write-effect receipts and soft-review settlement.
--
-- A write tool call is not recoverable from its provider-facing result alone:
-- the process may stop after entering the mutation, after the local effect
-- commits, or after the user chooses to reject it. These tables preserve each
-- boundary independently and bind it back to the exact runtime route, turn,
-- tool call, and idempotency key that produced it.

CREATE UNIQUE INDEX `uniq_agent_conversation_project_identity`
	ON `agent_conversation` (`id`,`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_session_project_identity`
	ON `agent_runtime_session` (`id`,`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_turn_session_identity`
	ON `agent_runtime_turn` (`id`,`session_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_tool_call_write_provenance`
	ON `agent_runtime_tool_call`
		(`id`,`session_id`,`turn_id`,`call_id`,`idempotency_key`,`access`,`name`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_write_effect` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`route_kind` text NOT NULL,
	`conversation_id` text,
	`goal_run_id` text,
	`chapter_id` text,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_access` text DEFAULT 'write' NOT NULL,
	`idempotency_key` text NOT NULL,
	`phase` text DEFAULT 'claimed' NOT NULL,
	`arguments_json` text NOT NULL,
	`expected_revision_json` text,
	`observed_revision_json` text,
	`preimage_json` text,
	`forward_json` text,
	`inverse_json` text,
	`reversibility` text,
	`effect_json` text,
	`result_json` text,
	`error_code` text,
	`error_message` text,
	`claimed_at` text NOT NULL,
	`confirmed_at` text,
	`mutation_started_at` text,
	`effect_committed_at` text,
	`result_committed_at` text,
	`uncertain_at` text,
	`failed_at` text,
	`declined_at` text,
	`updated_at` text NOT NULL,
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
	FOREIGN KEY (`conversation_id`,`project_id`)
		REFERENCES `agent_conversation`(`id`,`project_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`route_kind` IN ('chat', 'goal')),
	CHECK (
		(`route_kind` = 'chat'
			AND `conversation_id` IS NOT NULL
			AND length(`conversation_id`) > 0
			AND `goal_run_id` IS NULL
			AND `chapter_id` IS NULL)
		OR
		(`route_kind` = 'goal' AND `conversation_id` IS NULL)
	),
	CHECK (`goal_run_id` IS NULL OR length(`goal_run_id`) > 0),
	CHECK (`chapter_id` IS NULL OR length(`chapter_id`) > 0),
	CHECK (`tool_access` = 'write'),
	CHECK (length(`tool_name`) > 0),
	CHECK (length(`call_id`) > 0),
	CHECK (length(`idempotency_key`) > 0),
	CHECK (`phase` IN (
		'claimed',
		'confirmed',
		'mutation_started',
		'effect_committed',
		'result_committed',
		'uncertain',
		'failed',
		'declined'
	)),
	CHECK (`reversibility` IS NULL OR `reversibility` IN (
		'exact',
		'compensating',
		'irreversible',
		'unavailable'
	)),
	CHECK (
		`phase` NOT IN (
			'confirmed',
			'mutation_started',
			'effect_committed',
			'result_committed',
			'uncertain'
		)
		OR `confirmed_at` IS NOT NULL
	),
	CHECK (
		`phase` NOT IN (
			'mutation_started',
			'effect_committed',
			'result_committed',
			'uncertain'
		)
		OR (
			`mutation_started_at` IS NOT NULL
			AND `observed_revision_json` IS NOT NULL
			AND `preimage_json` IS NOT NULL
			AND `forward_json` IS NOT NULL
			AND `reversibility` IS NOT NULL
			AND (
				`reversibility` IN ('irreversible', 'unavailable')
				OR `inverse_json` IS NOT NULL
			)
		)
	),
	CHECK (
		`phase` NOT IN ('effect_committed', 'result_committed')
		OR (`effect_committed_at` IS NOT NULL AND `effect_json` IS NOT NULL)
	),
	CHECK (
		`phase` <> 'result_committed'
		OR (`result_committed_at` IS NOT NULL AND `result_json` IS NOT NULL)
	),
	CHECK (
		`phase` <> 'uncertain'
		OR (
			`uncertain_at` IS NOT NULL
			AND `error_code` IS NOT NULL
			AND length(`error_code`) > 0
		)
	),
	CHECK (
		`phase` <> 'failed'
		OR (
			`mutation_started_at` IS NULL
			AND `failed_at` IS NOT NULL
			AND `error_code` IS NOT NULL
			AND length(`error_code`) > 0
		)
	),
	CHECK (
		`phase` <> 'declined'
		OR (`mutation_started_at` IS NULL AND `declined_at` IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_effect_tool_call`
	ON `agent_runtime_write_effect` (`tool_call_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_effect_idempotency`
	ON `agent_runtime_write_effect` (`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_effect_turn_call`
	ON `agent_runtime_write_effect` (`turn_id`,`call_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_effect_provenance`
	ON `agent_runtime_write_effect`
		(`id`,`session_id`,`turn_id`,`tool_call_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_write_effect_session_phase`
	ON `agent_runtime_write_effect` (`session_id`,`phase`);
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
		AND `session`.`goal_run_id` IS NEW.`goal_run_id`
		AND `session`.`chapter_id` IS NEW.`chapter_id`
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
	`goal_run_id`,
	`chapter_id`,
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
		AND `session`.`goal_run_id` IS NEW.`goal_run_id`
		AND `session`.`chapter_id` IS NEW.`chapter_id`
)
BEGIN
	SELECT RAISE(ABORT, 'agent write effect route provenance mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_session_effect_route_update`
BEFORE UPDATE OF
	`project_id`,
	`route_kind`,
	`conversation_id`,
	`goal_run_id`,
	`chapter_id`
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
			OR `effect`.`goal_run_id` IS NOT NEW.`goal_run_id`
			OR `effect`.`chapter_id` IS NOT NEW.`chapter_id`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'agent runtime session route has durable write effects');
END;
--> statement-breakpoint

CREATE TABLE `agent_runtime_write_review` (
	`id` text PRIMARY KEY NOT NULL,
	`effect_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_note_json` text,
	`revert_effect_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`accepted_at` text,
	`rejected_at` text,
	`revert_started_at` text,
	`settled_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`effect_id`,`session_id`,`turn_id`,`tool_call_id`)
		REFERENCES `agent_runtime_write_effect`
			(`id`,`session_id`,`turn_id`,`tool_call_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`status` IN (
		'pending',
		'accepted',
		'rejected',
		'accepted_effect',
		'revert_started',
		'reverted',
		'revert_failed',
		'revert_unavailable'
	)),
	CHECK (
		`status` NOT IN ('accepted', 'accepted_effect')
		OR `accepted_at` IS NOT NULL
	),
	CHECK (
		`status` NOT IN (
			'rejected',
			'revert_started',
			'reverted',
			'revert_failed',
			'revert_unavailable'
		)
		OR `rejected_at` IS NOT NULL
	),
	CHECK (
		`status` NOT IN ('revert_started', 'reverted', 'revert_failed')
		OR `revert_started_at` IS NOT NULL
	),
	CHECK (
		`status` NOT IN (
			'accepted_effect',
			'reverted',
			'revert_failed',
			'revert_unavailable'
		)
		OR `settled_at` IS NOT NULL
	),
	CHECK (
		`status` <> 'reverted' OR `revert_effect_json` IS NOT NULL
	),
	CHECK (
		`status` NOT IN ('revert_failed', 'revert_unavailable')
		OR (
			`error_code` IS NOT NULL
			AND length(`error_code`) > 0
		)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_write_review_effect`
	ON `agent_runtime_write_review` (`effect_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_write_review_session_status`
	ON `agent_runtime_write_review` (`session_id`,`status`);
