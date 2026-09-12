/** Tables read by the workspace projection, including indirect dependencies. */
export const WORKSPACE_PROJECTION_SOURCES = [
  { table: 'project', collection: 'project', project: '{row}.id', entity: '{row}.id' },
  { table: 'book_node', collection: 'nodes', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'storylines', collection: 'storylines', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'element', collection: 'elements', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'element_category', collection: 'categories', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'project_asset', collection: 'assets', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'library_item', collection: 'library', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'comment', collection: 'comments', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'comment_action', collection: 'comment-actions', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'entity_relation', collection: 'relations', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'entity_relation_type', collection: 'relation-types', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'entity_relation_type_endpoint_kind', collection: 'relation-types', project: '(SELECT project_id FROM entity_relation_type WHERE id = {row}.relation_type_id)', entity: '{row}.relation_type_id' },
  { table: 'block_section', collection: 'sections', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'book_act', collection: 'acts', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'drift_group', collection: 'drift-groups', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'timeline_marker', collection: 'markers', project: '{row}.project_id', entity: '{row}.id' },
  { table: 'node_storyline_link', collection: 'memberships', project: '(SELECT project_id FROM book_node WHERE id = {row}.node_id)', entity: '{row}.node_id' },
] as const;

export type WorkspaceProjectionCollection = typeof WORKSPACE_PROJECTION_SOURCES[number]['collection'];
export const WORKSPACE_PROJECTION_COLLECTIONS: readonly WorkspaceProjectionCollection[] =
  [...new Set(WORKSPACE_PROJECTION_SOURCES.map((source) => source.collection))];

/** SQL triggers compact at this boundary; a reader behind the floor reads all. */
export const WORKSPACE_PROJECTION_MAX_CHANGES = 4_096;
