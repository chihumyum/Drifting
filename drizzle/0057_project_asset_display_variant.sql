-- Rename the initially uploaded "original" object fields to "display".
-- The app now uploads a compressed display image plus a thumbnail, while
-- source_* keeps metadata about the user's original local file.

ALTER TABLE `project_asset` RENAME COLUMN `original_object_key` TO `display_object_key`;
--> statement-breakpoint
ALTER TABLE `project_asset` RENAME COLUMN `original_mime` TO `display_mime`;
--> statement-breakpoint
ALTER TABLE `project_asset` RENAME COLUMN `original_size_bytes` TO `display_size_bytes`;
--> statement-breakpoint
ALTER TABLE `project_asset` ADD COLUMN `source_mime` text;
--> statement-breakpoint
ALTER TABLE `project_asset` ADD COLUMN `source_size_bytes` integer;
--> statement-breakpoint
UPDATE `project_asset`
SET `source_mime` = `display_mime`
WHERE `source_mime` IS NULL;
--> statement-breakpoint
UPDATE `project_asset`
SET `source_size_bytes` = `display_size_bytes`
WHERE `source_size_bytes` IS NULL;
