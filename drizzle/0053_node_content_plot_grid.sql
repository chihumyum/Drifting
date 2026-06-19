-- In-chapter plot planner grid. A per-node "mini-Excel" scratchpad authored
-- upstream of prose: decoupled from outline/summary (not derived from the text)
-- and outside the dep-graph/shadow. Stored as sparse JSON alongside
-- content_json. See domain/plot-grid.ts.

ALTER TABLE `node_content` ADD COLUMN `plot_grid_json` text DEFAULT '{}';
