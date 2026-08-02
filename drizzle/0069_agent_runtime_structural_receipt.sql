-- Expand immutable Agent entity receipts to every certified structural CRUD
-- command. Workspace-style write_file/edit_file/delete_file tools keep their
-- public provenance while the receipt records the exact hidden domain command.

DROP TRIGGER IF EXISTS `trg_agent_runtime_entity_write_receipt_provenance`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_agent_runtime_entity_write_receipt_immutable`;
--> statement-breakpoint
DROP TABLE IF EXISTS `agent_runtime_entity_write_receipt_next`;
--> statement-breakpoint

CREATE TABLE `agent_runtime_entity_write_receipt_next` (
	`id` text PRIMARY KEY NOT NULL,
	`effect_id` text NOT NULL,
	`command_id` text NOT NULL,
	`direction` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`expected_revision` text,
	`result_revision` text,
	`preimage_json` text,
	`preimage_hash` text,
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
	CHECK (`tool_name` IN (
		'create_comment',
		'update_comment',
		'delete_comment',
		'set_comment_status',
		'set_comment_kind',
		'create_node',
		'delete_node',
		'create_element',
		'delete_element',
		'create_storyline',
		'delete_storyline',
		'create_category',
		'update_category',
		'delete_category',
		'add_relation',
		'update_relation_kind',
		'remove_relation',
		'update_element',
		'update_storyline',
		'update_project_facts'
	)),
	CHECK (`entity_kind` IN (
		'comment',
		'node',
		'element',
		'storyline',
		'category',
		'relation',
		'project'
	)),
	CHECK (length(`command_id`) > 0),
	CHECK (length(`project_id`) > 0),
	CHECK (length(`session_id`) > 0),
	CHECK (length(`entity_id`) > 0),
	CHECK (
		(`preimage_json` IS NULL AND `preimage_hash` IS NULL)
		OR
		(`preimage_json` IS NOT NULL
			AND length(`preimage_json`) > 0
			AND `preimage_hash` IS NOT NULL
			AND length(`preimage_hash`) = 71
			AND substr(`preimage_hash`, 1, 7) = 'sha256:'
			AND substr(`preimage_hash`, 8) NOT GLOB '*[^0-9a-f]*')
	),
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

INSERT INTO `agent_runtime_entity_write_receipt_next` (
	`id`,
	`effect_id`,
	`command_id`,
	`direction`,
	`project_id`,
	`session_id`,
	`tool_name`,
	`entity_kind`,
	`entity_id`,
	`expected_revision`,
	`result_revision`,
	`preimage_json`,
	`preimage_hash`,
	`postimage_json`,
	`postimage_hash`,
	`created_at`
)
SELECT
	`id`,
	`effect_id`,
	`command_id`,
	`direction`,
	`project_id`,
	`session_id`,
	`tool_name`,
	`entity_kind`,
	`entity_id`,
	`expected_revision`,
	`result_revision`,
	`preimage_json`,
	`preimage_hash`,
	`postimage_json`,
	`postimage_hash`,
	`created_at`
FROM `agent_runtime_entity_write_receipt`;
--> statement-breakpoint
DROP TABLE `agent_runtime_entity_write_receipt`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_entity_write_receipt_next`
	RENAME TO `agent_runtime_entity_write_receipt`;
--> statement-breakpoint

CREATE UNIQUE INDEX `uniq_agent_runtime_entity_write_receipt_command`
	ON `agent_runtime_entity_write_receipt` (`command_id`,`direction`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_runtime_entity_write_receipt_effect`
	ON `agent_runtime_entity_write_receipt` (`effect_id`,`direction`);
--> statement-breakpoint
CREATE INDEX `idx_agent_runtime_entity_write_receipt_entity`
	ON `agent_runtime_entity_write_receipt` (`project_id`,`entity_kind`,`entity_id`);
--> statement-breakpoint

CREATE TRIGGER `trg_agent_runtime_entity_write_receipt_provenance`
BEFORE INSERT ON `agent_runtime_entity_write_receipt`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_runtime_write_effect` AS `effect`
	WHERE `effect`.`id` = NEW.`effect_id`
		AND `effect`.`project_id` = NEW.`project_id`
		AND `effect`.`session_id` = NEW.`session_id`
		AND (
			`effect`.`tool_name` = NEW.`tool_name`
			OR (
				`effect`.`tool_name` IN ('edit_file', 'write_file', 'delete_file')
				AND json_valid(`effect`.`arguments_json`) = 1
				AND json_extract(
					`effect`.`arguments_json`,
					'$.__workspaceCommand.name'
				) = NEW.`tool_name`
			)
		)
		AND `effect`.`phase` IN (
			'mutation_started',
			'effect_committed',
			'result_committed'
		)
)
BEGIN
	SELECT RAISE(ABORT, 'agent entity write receipt provenance mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_agent_runtime_entity_write_receipt_immutable`
BEFORE UPDATE ON `agent_runtime_entity_write_receipt`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'agent entity write receipt is immutable');
END;
