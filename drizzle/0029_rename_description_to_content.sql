-- Rename `description_json` to `content_json` on storylines + element_category.
-- These columns held the body editor's TipTap JSON, not a "description"; the
-- new name aligns with element.content_json / node_content.content_json.
-- project.description_json is unrelated and stays as-is.
--
-- SQLite 3.25+ supports `ALTER TABLE ... RENAME COLUMN ...` natively.
-- electron 40 ships with sqlite ≥3.40, no table rebuild needed.

ALTER TABLE `storylines` RENAME COLUMN `description_json` TO `content_json`;
--> statement-breakpoint
ALTER TABLE `element_category` RENAME COLUMN `description_json` TO `content_json`;
