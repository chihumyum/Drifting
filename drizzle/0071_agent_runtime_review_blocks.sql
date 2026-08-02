-- Make prose review blocks first-class durable state. The whole-effect review
-- remains the author-facing batch, while every paragraph decision now survives
-- renderer/localStorage loss and an entered selective inverse can be retried
-- idempotently after restart.

CREATE UNIQUE INDEX IF NOT EXISTS `uniq_agent_runtime_write_review_provenance`
	ON `agent_runtime_write_review` (`id`,`effect_id`);
--> statement-breakpoint

CREATE TABLE `agent_runtime_write_review_block` (
	`review_id` text NOT NULL,
	`effect_id` text NOT NULL,
	`block_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`decision_note_json` text,
	`revert_effect_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`revert_started_at` text,
	`settled_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`review_id`,`block_id`),
	FOREIGN KEY (`review_id`,`effect_id`)
		REFERENCES `agent_runtime_write_review`(`id`,`effect_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`ordinal` >= 0),
	CHECK (length(`block_id`) > 0),
	CHECK (`status` IN (
		'pending',
		'accepted',
		'revert_started',
		'reverted',
		'revert_failed'
	))
);
--> statement-breakpoint

CREATE UNIQUE INDEX `uniq_agent_runtime_write_review_block_ordinal`
	ON `agent_runtime_write_review_block` (`review_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_write_review_block_status`
	ON `agent_runtime_write_review_block` (`review_id`,`status`);
