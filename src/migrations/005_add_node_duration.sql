-- Add duration field to story_node table for timeline width
ALTER TABLE story_node ADD COLUMN duration INTEGER DEFAULT 4;

-- Update index to include duration for better query performance
CREATE INDEX IF NOT EXISTS idx_story_node_timeline ON story_node(project_id, order_key, duration);
