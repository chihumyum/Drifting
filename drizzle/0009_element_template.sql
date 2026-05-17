-- Add element_template_json to element_category. Stores a TipTap doc JSON
-- (or '{}' for "no template") that gets seeded into new elements created
-- under this category. Existing elements are not touched.
ALTER TABLE `element_category` ADD `element_template_json` text DEFAULT '{}';
