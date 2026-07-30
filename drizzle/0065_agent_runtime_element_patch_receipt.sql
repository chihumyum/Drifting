-- Immutable domain receipts for certified create/update element_patch writes.
--
-- The receipt is inserted in the same transaction as element_patch and the
-- local sync mutation. It proves an entered command without re-dispatching it
-- after a renderer/process death.

CREATE TABLE `agent_runtime_element_patch_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`effect_id` text NOT NULL,
	`command_id` text NOT NULL,
	`direction` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`patch_id` text NOT NULL,
	`expected_revision` text,
	`result_revision` text,
	`postimage_json` text,
	`postimage_hash` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`effect_id`)
		REFERENCES `agent_runtime_write_effect`(`id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (`session_id`,`project_id`)
		REFERENCES `agent_runtime_session`(`id`,`project_id`)
		ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`direction` IN ('forward', 'inverse')),
	CHECK (`tool_name` IN ('create_element_patch', 'update_element_patch')),
	CHECK (length(`command_id`) > 0),
	CHECK (length(`project_id`) > 0),
	CHECK (length(`session_id`) > 0),
	CHECK (length(`patch_id`) > 0),
	CHECK (
		(`result_revision` IS NULL
			AND `postimage_json` IS NULL
			AND `postimage_hash` IS NULL)
		OR
		(`result_revision` IS NOT NULL
			AND length(`result_revision`) > 0
			AND `postimage_json` IS NOT NULL
			AND length(`postimage_json`) > 0
			AND `postimage_hash` IS NOT NULL
			AND length(`postimage_hash`) = 71
			AND substr(`postimage_hash`, 1, 7) = 'sha256:'
			AND substr(`postimage_hash`, 8) NOT GLOB '*[^0-9a-f]*')
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_element_patch_receipt_command`
	ON `agent_runtime_element_patch_receipt` (`command_id`,`direction`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_element_patch_receipt_effect`
	ON `agent_runtime_element_patch_receipt` (`effect_id`,`direction`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_element_patch_receipt_patch`
	ON `agent_runtime_element_patch_receipt` (`project_id`,`patch_id`);
--> statement-breakpoint

CREATE TRIGGER `trg_agent_runtime_element_patch_receipt_provenance`
BEFORE INSERT ON `agent_runtime_element_patch_receipt`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_write_effect` AS `effect`
	WHERE `effect`.`id` = NEW.`effect_id`
		AND `effect`.`project_id` = NEW.`project_id`
		AND `effect`.`session_id` = NEW.`session_id`
		AND `effect`.`tool_name` = NEW.`tool_name`
		AND `effect`.`phase` IN (
			'mutation_started',
			'effect_committed',
			'result_committed'
		)
)
BEGIN
	SELECT RAISE(ABORT, 'agent element patch receipt provenance mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_element_patch_receipt_immutable`
BEFORE UPDATE ON `agent_runtime_element_patch_receipt`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent element patch receipt is immutable');
END;
