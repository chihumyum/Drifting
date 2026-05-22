-- Free-form user category for the relation itself (NOT the endpoint type;
-- that's from_kind / to_kind). Mirrors book_node_edge.kind. Null = unset.
-- SuperElementView's shift-click modal writes this for manual relations;
-- existing rows stay null until the user assigns one.
ALTER TABLE `entity_reference` ADD COLUMN `kind` text;
