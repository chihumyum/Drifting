-- Project description_json was a lightweight metadata container, not a TipTap
-- document. Promote the actual book summary to a first-class column and move
-- the optional display metadata into the project's extensible KV list.

ALTER TABLE `project` ADD COLUMN `summary` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `project`
SET `summary` = CASE
	WHEN json_valid(`description_json`) AND json_type(`description_json`, '$.summary') = 'text'
		THEN trim(json_extract(`description_json`, '$.summary'))
	WHEN json_valid(`description_json`) AND json_type(`description_json`) = 'text'
		THEN trim(json_extract(`description_json`, '$'))
	WHEN NOT json_valid(`description_json`)
		THEN trim(COALESCE(`description_json`, ''))
	ELSE ''
END;
--> statement-breakpoint
UPDATE `project`
SET `kv_json` = '[]'
WHERE NOT json_valid(`kv_json`) OR json_type(`kv_json`) <> 'array';
--> statement-breakpoint
UPDATE `project`
SET `kv_json` = json_insert(
	`kv_json`,
	'$[#]',
	json_object('key', '副标题', 'value', trim(json_extract(`description_json`, '$.subtitle')))
)
WHERE json_valid(`description_json`)
	AND json_type(`description_json`, '$.subtitle') = 'text'
	AND trim(json_extract(`description_json`, '$.subtitle')) <> ''
	AND NOT EXISTS (
		SELECT 1
		FROM json_each(`project`.`kv_json`) AS `entry`
		WHERE json_extract(`entry`.`value`, '$.key') = '副标题'
	);
--> statement-breakpoint
UPDATE `project`
SET `kv_json` = json_insert(
	`kv_json`,
	'$[#]',
	json_object('key', '体裁', 'value', trim(json_extract(`description_json`, '$.genre')))
)
WHERE json_valid(`description_json`)
	AND json_type(`description_json`, '$.genre') = 'text'
	AND trim(json_extract(`description_json`, '$.genre')) <> ''
	AND NOT EXISTS (
		SELECT 1
		FROM json_each(`project`.`kv_json`) AS `entry`
		WHERE json_extract(`entry`.`value`, '$.key') = '体裁'
	);
--> statement-breakpoint
UPDATE `local_sync_mutation`
SET `payload_json` = json_set(
	json_remove(`payload_json`, '$.descriptionJson'),
	'$.summary',
	CASE
		WHEN json_valid(json_extract(`payload_json`, '$.descriptionJson'))
			AND json_type(json_extract(`payload_json`, '$.descriptionJson'), '$.summary') = 'text'
			THEN trim(json_extract(json_extract(`payload_json`, '$.descriptionJson'), '$.summary'))
		WHEN NOT json_valid(json_extract(`payload_json`, '$.descriptionJson'))
			THEN trim(COALESCE(json_extract(`payload_json`, '$.descriptionJson'), ''))
		ELSE ''
	END,
	'$.kvJson',
	COALESCE(
		(SELECT `kv_json` FROM `project` WHERE `project`.`id` = `local_sync_mutation`.`entity_id`),
		'[]'
	)
)
WHERE `entity_type` = 'project'
	AND json_valid(`payload_json`)
	AND json_type(`payload_json`) = 'object'
	AND json_type(`payload_json`, '$.descriptionJson') = 'text';
--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `description_json`;
