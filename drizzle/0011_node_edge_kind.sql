-- Phase 4: GraphView relation chips need a user-defined category. We add
-- `kind` as a nullable text column on book_node_edge; the value is whatever
-- string the author types (e.g. "引用", "同人物"). No default vocabulary —
-- the GraphView filter UI just lists distinct values found in the data.
ALTER TABLE `book_node_edge` ADD COLUMN `kind` text;
