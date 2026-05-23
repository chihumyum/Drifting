-- Fold legacy book_node_edge rows into entity_reference and drop the table.
-- Visual columns (label/weight/isDirected/styleJson/controlPointOffset/anchors)
-- were never read by the renderer; they are intentionally dropped.
INSERT INTO entity_reference (
  id, project_id,
  from_kind, from_id, from_block_id, from_spans_json,
  to_kind, to_id, to_block_id,
  origin, confidence, kind,
  created_at, updated_at
)
SELECT
  id, project_id,
  'node', source_node_id, NULL, NULL,
  'node', target_node_id, NULL,
  'manual', NULL, kind,
  created_at, updated_at
FROM book_node_edge;
--> statement-breakpoint
DROP TABLE book_node_edge;
