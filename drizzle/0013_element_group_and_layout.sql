-- SuperElementView groundwork.
--
-- (1) element.group_name: a lightweight secondary grouping label inside a
--     category. Null = "ungrouped" bucket. No separate entity — same string
--     under different categories means different things. Promote to a real
--     table only if/when we need ordering or colors.
--
-- (2) element_category.layout_mode + grid_x + grid_y: SuperElementView places
--     categories on a grid-aligned canvas. 'auto' lets the skyline solver
--     pick a slot; 'pinned' means the user dragged the category and grid_x /
--     grid_y are its anchor (treated as obstacles by the solver). Existing
--     rows default to 'auto' with null coords.
ALTER TABLE `element` ADD COLUMN `group_name` text;
--> statement-breakpoint
ALTER TABLE `element_category` ADD COLUMN `layout_mode` text NOT NULL DEFAULT 'auto';
--> statement-breakpoint
ALTER TABLE `element_category` ADD COLUMN `grid_x` integer;
--> statement-breakpoint
ALTER TABLE `element_category` ADD COLUMN `grid_y` integer;
