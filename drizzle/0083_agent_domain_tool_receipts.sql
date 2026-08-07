-- Public Agent effects now persist explicit author-domain tool names. The
-- transactional receipt continues to record the hidden certified command that
-- actually mutated SQLite/Yjs. Generic object/file facade names are not valid.
DROP TRIGGER IF EXISTS `trg_agent_runtime_entity_write_receipt_provenance`;
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
