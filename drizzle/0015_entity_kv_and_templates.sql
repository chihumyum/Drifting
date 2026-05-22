-- KV facts + child-template fields across the entity hierarchy.
--
-- Two complementary shapes:
--   * kv_json — an entity's own list of { key, value } pairs (JSON array
--     stringified). Read/written by the UI on Project / Storyline / Element.
--   * *_template_kv_json — KV template a parent entity defines that gets
--     seeded into each new child at creation time. Editing the template
--     never re-seeds existing children.
--
-- Project gains:
--   kv_json                       — book goal / writing style / reference
--                                   works, seeded with a default set on
--                                   project create (client-side).
--   storyline_template_kv_json   — template for storylines (POV / 主角 / …).
--
-- Storyline gains:
--   kv_json                       — seeded from project's
--                                   storyline_template_kv_json at creation.
--   node_content_template_json   — TipTap doc seeded into a new node's
--                                   NodeContent.contentJson under this
--                                   storyline. '{}' = no template.
--
-- element_category gains:
--   element_template_kv_json     — template for new elements of this
--                                   category (paired with the existing
--                                   element_template_json TipTap template).
--
-- element gains:
--   kv_json                       — seeded from category's
--                                   element_template_kv_json at creation.
ALTER TABLE `project` ADD COLUMN `kv_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `project` ADD COLUMN `storyline_template_kv_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `storylines` ADD COLUMN `kv_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `storylines` ADD COLUMN `node_content_template_json` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `element_category` ADD COLUMN `element_template_kv_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `element` ADD COLUMN `kv_json` text NOT NULL DEFAULT '[]';
