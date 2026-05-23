-- Drift nodes now use a separate status enum (DriftStatus): 'drifting' |
-- 'resting'. Existing drift rows were created before the split and carry the
-- chapter default 'draft'; flip them to 'drifting' so the editor menu and
-- drift-card visuals interpret them correctly.
UPDATE `book_node`
SET `writing_status` = 'drifting'
WHERE `main_storyline_id` IS NULL
  AND `writing_status` = 'draft';
