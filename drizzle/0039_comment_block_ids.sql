ALTER TABLE `comment` ADD COLUMN `target_block_ids_json` text DEFAULT '[]' NOT NULL;
