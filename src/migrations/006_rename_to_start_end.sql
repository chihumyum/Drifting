-- Rename order_key to start and duration to end
-- SQLite doesn't support renaming columns directly, so we need to recreate the table

-- Step 1: Create a new table with the updated schema
CREATE TABLE story_node_new (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  project_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER,
  summary TEXT,
  story_stage_id TEXT,
  pos_x REAL,
  pos_y REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES book_project(id),
  FOREIGN KEY (story_stage_id) REFERENCES story_stage(id) ON DELETE SET NULL
);

-- Step 2: Copy data from old table to new table
-- Convert order_key to start, and duration to end (end = start + duration)
INSERT INTO story_node_new (id, title, project_id, start, end, summary, story_stage_id, pos_x, pos_y, created_at, updated_at)
SELECT 
  id, 
  title, 
  project_id, 
  order_key as start,
  CASE 
    WHEN duration IS NOT NULL THEN order_key + duration
    ELSE NULL
  END as end,
  summary, 
  story_stage_id, 
  pos_x, 
  pos_y, 
  created_at, 
  updated_at
FROM story_node;

-- Step 3: Drop the old table
DROP TABLE story_node;

-- Step 4: Rename the new table
ALTER TABLE story_node_new RENAME TO story_node;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_story_node_project ON story_node(project_id);
CREATE INDEX IF NOT EXISTS idx_story_node_start ON story_node(project_id, start);
CREATE INDEX IF NOT EXISTS idx_story_node_stage ON story_node(story_stage_id);
