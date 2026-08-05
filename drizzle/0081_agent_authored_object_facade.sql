-- Fresh Agent turns persist the public authored-object verb on the outer
-- effect while the immutable receipt records the resolved domain command.
-- Keep the retired file-named facade valid for recovery of older effects.
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
					'revise_object', 'write_object', 'delete_object',
					'edit_file', 'write_file', 'delete_file'
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
