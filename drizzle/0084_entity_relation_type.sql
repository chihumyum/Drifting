CREATE TABLE `entity_relation_type` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`orientation` text NOT NULL,
	`source_role` text DEFAULT '' NOT NULL,
	`target_role` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `relation_type_orientation` CHECK (`orientation` in ('directed', 'symmetric', 'unconfigured'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_relation_type_project_name` ON `entity_relation_type` (`project_id`,`normalized_name`);
--> statement-breakpoint
CREATE INDEX `idx_relation_type_project` ON `entity_relation_type` (`project_id`);
--> statement-breakpoint
CREATE TABLE `entity_relation_type_endpoint_kind` (
	`relation_type_id` text NOT NULL,
	`side` text NOT NULL,
	`entity_kind` text NOT NULL,
	PRIMARY KEY(`relation_type_id`, `side`, `entity_kind`),
	FOREIGN KEY (`relation_type_id`) REFERENCES `entity_relation_type`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `relation_type_endpoint_side` CHECK (`side` in ('source', 'target'))
);
--> statement-breakpoint
ALTER TABLE `entity_relation` ADD `relation_type_id` text REFERENCES entity_relation_type(id) ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX `idx_relation_type` ON `entity_relation` (`relation_type_id`);
--> statement-breakpoint
INSERT INTO `entity_relation_type` (
	`id`, `project_id`, `name`, `normalized_name`, `description`, `orientation`,
	`source_role`, `target_role`, `created_at`, `updated_at`
)
SELECT
	'legacy:' || lower(hex(`project_id` || ':' || lower(trim(`kind`)))),
	`project_id`, min(trim(`kind`)), lower(trim(`kind`)), '', 'unconfigured', '', '',
	min(`created_at`), max(`updated_at`)
FROM `entity_relation`
WHERE `kind` IS NOT NULL AND trim(`kind`) <> ''
GROUP BY `project_id`, lower(trim(`kind`));
--> statement-breakpoint
INSERT INTO `entity_relation_type_endpoint_kind` (`relation_type_id`, `side`, `entity_kind`)
SELECT `id`, 'source', 'node' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'source', 'element' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'source', 'patch' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'source', 'category' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'source', 'storyline' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'source', 'comment' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'source', 'library_item' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'target', 'node' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'target', 'element' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'target', 'patch' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'target', 'category' FROM `entity_relation_type`
UNION ALL SELECT `id`, 'target', 'storyline' FROM `entity_relation_type`;
--> statement-breakpoint
UPDATE `entity_relation`
SET `relation_type_id` = 'legacy:' || lower(hex(`project_id` || ':' || lower(trim(`kind`))))
WHERE `kind` IS NOT NULL AND trim(`kind`) <> '';
--> statement-breakpoint
-- SQLite CHECK constraints are immutable, so widen the durable Agent receipt
-- contract by rebuilding the table. Existing receipts and their hashes remain
-- byte-for-byte unchanged.
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
	FOREIGN KEY (`effect_id`) REFERENCES `agent_runtime_write_effect`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	FOREIGN KEY (`session_id`,`project_id`) REFERENCES `agent_runtime_session`(`id`,`project_id`) ON UPDATE NO ACTION ON DELETE CASCADE,
	CHECK (`direction` IN ('forward', 'inverse')),
	CHECK (`tool_name` IN (
		'create_comment', 'update_comment', 'delete_comment',
		'set_comment_status', 'set_comment_kind',
		'create_node', 'delete_node',
		'create_element', 'delete_element',
		'create_storyline', 'delete_storyline',
		'create_category', 'update_category', 'delete_category',
		'add_relation', 'update_relation_kind', 'remove_relation',
		'create_relation_type', 'update_relation_type', 'delete_relation_type',
		'set_storyline_membership',
		'remember', 'update_memory', 'forget',
		'update_element', 'update_storyline', 'update_project_facts'
	)),
	CHECK (`entity_kind` IN (
		'comment', 'node', 'element', 'storyline', 'category', 'relation',
		'relation_type', 'storyline_membership', 'memory', 'project'
	)),
	CHECK (length(`command_id`) > 0),
	CHECK (length(`project_id`) > 0),
	CHECK (length(`session_id`) > 0),
	CHECK (length(`entity_id`) > 0),
	CHECK (
		(`preimage_json` IS NULL AND `preimage_hash` IS NULL)
		OR
		(`preimage_json` IS NOT NULL AND length(`preimage_json`) > 0
			AND `preimage_hash` IS NOT NULL AND length(`preimage_hash`) = 71
			AND substr(`preimage_hash`, 1, 7) = 'sha256:'
			AND substr(`preimage_hash`, 8) NOT GLOB '*[^0-9a-f]*')
	),
	CHECK (
		(`result_revision` IS NULL AND `postimage_json` IS NULL AND `postimage_hash` IS NULL)
		OR
		(`result_revision` IS NOT NULL AND length(`result_revision`) > 0
			AND `postimage_json` IS NOT NULL AND length(`postimage_json`) > 0
			AND `postimage_hash` IS NOT NULL AND length(`postimage_hash`) = 71
			AND substr(`postimage_hash`, 1, 7) = 'sha256:'
			AND substr(`postimage_hash`, 8) NOT GLOB '*[^0-9a-f]*')
	)
);
--> statement-breakpoint
INSERT INTO `agent_runtime_entity_write_receipt_next` SELECT * FROM `agent_runtime_entity_write_receipt`;
--> statement-breakpoint
DROP TABLE `agent_runtime_entity_write_receipt`;
--> statement-breakpoint
ALTER TABLE `agent_runtime_entity_write_receipt_next` RENAME TO `agent_runtime_entity_write_receipt`;
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
	SELECT 1 FROM `agent_runtime_write_effect` AS `effect`
	WHERE `effect`.`id` = NEW.`effect_id`
		AND `effect`.`project_id` = NEW.`project_id`
		AND `effect`.`session_id` = NEW.`session_id`
		AND (
			`effect`.`tool_name` = NEW.`tool_name`
			OR (
				`effect`.`tool_name` IN (
					'create_chapter', 'rename_chapter', 'set_chapter_summary',
					'revise_chapter', 'replace_chapter_body', 'delete_chapter',
					'create_inspiration', 'rename_inspiration', 'set_inspiration_summary',
					'revise_inspiration', 'replace_inspiration_body', 'delete_inspiration',
					'revise_element', 'replace_element_body',
					'create_element_category', 'update_element_category',
					'replace_element_category_body', 'delete_element_category',
					'revise_storyline', 'replace_storyline_body', 'delete_storyline',
					'add_chapter_to_storyline', 'remove_chapter_from_storyline',
					'set_chapter_primary_storyline', 'replace_storyline_chapters',
					'create_relation', 'update_relation', 'delete_relation',
					'update_comment',
					'create_author_rule', 'update_author_rule', 'delete_author_rule'
				)
				AND json_valid(`effect`.`arguments_json`) = 1
				AND json_extract(`effect`.`arguments_json`, '$.__workspaceCommand.name') = NEW.`tool_name`
			)
		)
		AND `effect`.`phase` IN ('mutation_started', 'effect_committed', 'result_committed')
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
