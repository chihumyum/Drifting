/**
 * Pure capability contract for the model-facing Drifting workspace.
 *
 * Keep this module free of renderer/database imports so documentation and
 * headless capability tooling can load the exact production names in Node.
 */
export const DRIFTING_DOMAIN_READ_TOOLS = [
  'get_project_overview',
  'get_project_facts',
  'list_chapters',
  'read_chapter',
  'list_inspirations',
  'read_inspiration',
  'list_element_categories',
  'read_element_category',
  'list_elements',
  'read_element',
  'get_element_patches',
  'find_element_appearances',
  'list_storylines',
  'read_storyline',
  'list_relations',
  'list_relation_types',
  'list_entity_relations',
  'list_comments',
  'list_project_memory',
  'list_materials',
  'read_material',
  'read_book_structure',
  'read_plot_grid',
  'view_material',
  'search_prose',
  'search_project',
] as const;

export const DRIFTING_DOMAIN_WRITE_TOOLS = [
  'create_chapter',
  'rename_chapter',
  'set_chapter_summary',
  'revise_chapter',
  'replace_chapter_body',
  'delete_chapter',
  'create_inspiration',
  'rename_inspiration',
  'set_inspiration_summary',
  'revise_inspiration',
  'replace_inspiration_body',
  'delete_inspiration',
  'create_element',
  'update_element',
  'revise_element',
  'replace_element_body',
  'delete_element',
  'create_element_category',
  'update_element_category',
  'replace_element_category_body',
  'delete_element_category',
  'create_storyline',
  'update_storyline',
  'revise_storyline',
  'replace_storyline_body',
  'delete_storyline',
  'add_chapter_to_storyline',
  'remove_chapter_from_storyline',
  'set_chapter_primary_storyline',
  'replace_storyline_chapters',
  'create_relation',
  'update_relation',
  'delete_relation',
  'create_relation_type',
  'update_relation_type',
  'delete_relation_type',
  'create_comment',
  'update_comment',
  'delete_comment',
  'update_project_facts',
  'create_project_memory',
  'update_project_memory',
  'delete_project_memory',
  'create_element_patch',
  'update_element_patch',
  'delete_element_patch',
  'create_material_note',
  'revise_material_note',
  'replace_material_note_body',
  'update_material',
  'create_material_folder',
  'update_material_folder',
  'delete_material_folder',
  'create_act',
  'update_act',
  'delete_act',
  'move_chapter',
  'set_timeline_position',
  'create_timeline_marker',
  'update_timeline_marker',
  'delete_timeline_marker',
  'write_plot_grid',
] as const;

/**
 * Workbench commands (drifting-workbench-types.ts): direct writes that plan
 * one whole scope image — the material library, the book structure, a plot
 * grid — and keep it as their freshness revision and exact inverse.
 */
export const WORKBENCH_COMMAND_NAMES = [
  'create_material_note',
  'update_material',
  'create_material_folder',
  'update_material_folder',
  'delete_material_folder',
  'create_act',
  'update_act',
  'delete_act',
  'move_chapter',
  'set_timeline_position',
  'create_timeline_marker',
  'update_timeline_marker',
  'delete_timeline_marker',
  'write_plot_grid',
] as const;

/** Direct writes to a material note's own Yjs document. */
export const MATERIAL_NOTE_COMMAND_NAMES = [
  'revise_material_note',
  'replace_material_note_body',
] as const;

export type WorkbenchCommandName = (typeof WORKBENCH_COMMAND_NAMES)[number];
export type MaterialNoteCommandName = (typeof MATERIAL_NOTE_COMMAND_NAMES)[number];

export function isWorkbenchCommandName(name: string): name is WorkbenchCommandName {
  return (WORKBENCH_COMMAND_NAMES as readonly string[]).includes(name);
}

export function isMaterialNoteCommandName(name: string): name is MaterialNoteCommandName {
  return (MATERIAL_NOTE_COMMAND_NAMES as readonly string[]).includes(name);
}

/** Public domain tools whose canonical certified strategy already has the same
 * name. The runtime still supplies freshness; the model never does. */
export const DRIFTING_DOMAIN_DIRECT_WRITE_TOOLS = [
  'create_element',
  'update_element',
  'delete_element',
  'create_storyline',
  'update_storyline',
  'create_comment',
  'delete_comment',
  'update_project_facts',
  'create_element_patch',
  'update_element_patch',
  'delete_element_patch',
  'create_relation_type',
  'update_relation_type',
  'delete_relation_type',
  ...WORKBENCH_COMMAND_NAMES,
  ...MATERIAL_NOTE_COMMAND_NAMES,
] as const;
/** Stable semantic receipt used to retire side-effect-free write pairs from
 * provider context without exposing runtime mechanics. */
export const WORKSPACE_NOOP_WRITE_MODEL_MARKER = '已经是所需内容，无需修改' as const;
export const WORKSPACE_COMPLETE_READ_MODEL_MARKER = '该正文已在本轮完整通读' as const;

export const DRIFTING_DOMAIN_PROVIDER_TOOLS = [
  ...DRIFTING_DOMAIN_READ_TOOLS,
  ...DRIFTING_DOMAIN_WRITE_TOOLS,
] as const;

export function isDriftingDomainProviderToolName(
  name: string,
): name is DriftingDomainProviderToolName {
  return (DRIFTING_DOMAIN_PROVIDER_TOOLS as readonly string[]).includes(name);
}

export function isDriftingDomainReadToolName(name: string): name is DriftingDomainReadToolName {
  return (DRIFTING_DOMAIN_READ_TOOLS as readonly string[]).includes(name);
}

export function isDriftingDomainWriteToolName(name: string): name is DriftingDomainWriteToolName {
  return (DRIFTING_DOMAIN_WRITE_TOOLS as readonly string[]).includes(name);
}

export function isDriftingDomainDirectWriteToolName(
  name: string,
): name is (typeof DRIFTING_DOMAIN_DIRECT_WRITE_TOOLS)[number] {
  return (DRIFTING_DOMAIN_DIRECT_WRITE_TOOLS as readonly string[]).includes(name);
}

/** Hidden domain commands produced only after a workspace path is resolved. */
export const DRIFTING_WORKSPACE_COMMAND_NAMES = [
  'edit_prose_file',
  'rename_node',
  'set_node_summary',
  'update_element',
  'update_storyline',
  'update_project_facts',
  'create_node',
  'delete_node',
  'create_element',
  'delete_element',
  'create_storyline',
  'delete_storyline',
  'create_category',
  'update_category',
  'delete_category',
  'create_comment',
  'update_comment',
  'delete_comment',
  'add_relation',
  'assign_relation_type',
  'remove_relation',
  'create_relation_type',
  'update_relation_type',
  'delete_relation_type',
  'set_storyline_membership',
  'remember',
  'update_memory',
  'forget',
  'create_element_patch',
  'update_element_patch',
  'delete_element_patch',
] as const;

export type DriftingDomainReadToolName = (typeof DRIFTING_DOMAIN_READ_TOOLS)[number];
export type DriftingDomainWriteToolName = (typeof DRIFTING_DOMAIN_WRITE_TOOLS)[number];
export type DriftingDomainProviderToolName =
  (typeof DRIFTING_DOMAIN_PROVIDER_TOOLS)[number];
export type DriftingWorkspaceCommandName =
  (typeof DRIFTING_WORKSPACE_COMMAND_NAMES)[number];

export type DriftingDomainCrudOperation =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'revert';

export interface DriftingDomainCrudOperationContract {
  status: 'closed' | 'not_applicable';
  providerTools: readonly string[];
  hiddenCommands: readonly DriftingWorkspaceCommandName[];
  approval:
    | 'automatic'
    | 'confirm_before'
    | 'not_applicable';
  authority: 'sqlite' | 'yjs_sqlite';
}

export interface DriftingDomainCrudContract {
  domain:
    | 'node'
    | 'element'
    | 'element_patch'
    | 'storyline'
    | 'category'
    | 'comment_todo'
    | 'entity_relation'
    | 'relation_type'
    | 'storyline_membership'
    | 'agent_memory'
    | 'project_facts'
    | 'material'
    | 'material_folder'
    | 'act'
    | 'book_order'
    | 'timeline'
    | 'plot_grid';
  authoredTargets: readonly string[];
  operations: Readonly<
    Record<DriftingDomainCrudOperation, DriftingDomainCrudOperationContract>
  >;
}

const closedRead = (
  providerTools: readonly string[],
  authority: DriftingDomainCrudOperationContract['authority'] = 'sqlite',
): DriftingDomainCrudOperationContract => ({
  status: 'closed',
  providerTools,
  hiddenCommands: [],
  approval: 'automatic',
  authority,
});

const closedWrite = (
  providerTools: readonly DriftingDomainWriteToolName[],
  hiddenCommands: readonly DriftingWorkspaceCommandName[],
  approval: DriftingDomainCrudOperationContract['approval'],
  authority: DriftingDomainCrudOperationContract['authority'] = 'sqlite',
): DriftingDomainCrudOperationContract => ({
  status: 'closed',
  providerTools,
  hiddenCommands,
  approval,
  authority,
});

const exactRevert = (
  hiddenCommands: readonly DriftingWorkspaceCommandName[],
  authority: DriftingDomainCrudOperationContract['authority'] = 'sqlite',
): DriftingDomainCrudOperationContract => ({
  status: 'closed',
  providerTools: [],
  hiddenCommands,
  approval: 'not_applicable',
  authority,
});

const notApplicable: DriftingDomainCrudOperationContract = {
  status: 'not_applicable',
  providerTools: [],
  hiddenCommands: [],
  approval: 'not_applicable',
  authority: 'sqlite',
};

/**
 * Executable product lifecycle matrix behind the explicit domain-tool model
 * surface. `revert: closed` means the same hidden commands have immutable
 * receipts plus a guarded exact inverse; it does not advertise a second model
 * tool or an author-visible whole-session rewind surface.
 */
export const DRIFTING_DOMAIN_CRUD_CONTRACTS: readonly DriftingDomainCrudContract[] = [
  {
    domain: 'node',
    authoredTargets: ['章节「<名称>」', '构想「<名称>」'],
    operations: {
      create: closedWrite(
        ['create_chapter', 'create_inspiration'],
        ['create_node'],
        'automatic',
        'yjs_sqlite',
      ),
      read: closedRead(
        ['list_chapters', 'read_chapter', 'list_inspirations', 'read_inspiration', 'search_prose', 'search_project'],
        'yjs_sqlite',
      ),
      update: closedWrite(
        [
          'rename_chapter',
          'set_chapter_summary',
          'revise_chapter',
          'replace_chapter_body',
          'rename_inspiration',
          'set_inspiration_summary',
          'revise_inspiration',
          'replace_inspiration_body',
        ],
        ['edit_prose_file', 'rename_node', 'set_node_summary'],
        'automatic',
        'yjs_sqlite',
      ),
      delete: closedWrite(
        ['delete_chapter', 'delete_inspiration'],
        ['delete_node'],
        'confirm_before',
        'yjs_sqlite',
      ),
      revert: exactRevert(
        ['create_node', 'edit_prose_file', 'rename_node', 'set_node_summary', 'delete_node'],
        'yjs_sqlite',
      ),
    },
  },
  {
    domain: 'element',
    authoredTargets: ['要素「<名称>」（分类「<分类>」）'],
    operations: {
      create: closedWrite(['create_element'], ['create_element'], 'automatic', 'yjs_sqlite'),
      read: closedRead(
        ['list_elements', 'read_element', 'get_element_patches', 'find_element_appearances', 'search_prose', 'search_project'],
        'yjs_sqlite',
      ),
      update: closedWrite(
        ['update_element', 'revise_element', 'replace_element_body'],
        ['edit_prose_file', 'update_element'],
        'automatic',
        'yjs_sqlite',
      ),
      delete: closedWrite(['delete_element'], ['delete_element'], 'confirm_before', 'yjs_sqlite'),
      revert: exactRevert(
        ['create_element', 'edit_prose_file', 'update_element', 'delete_element'],
        'yjs_sqlite',
      ),
    },
  },
  {
    domain: 'element_patch',
    authoredTargets: ['要素「<名称>」的写作要素变更「<patchId>」'],
    operations: {
      create: closedWrite(
        ['create_element_patch'],
        ['create_element_patch'],
        'automatic',
      ),
      read: closedRead(['get_element_patches']),
      update: closedWrite(
        ['update_element_patch'],
        ['update_element_patch'],
        'automatic',
      ),
      delete: closedWrite(
        ['delete_element_patch'],
        ['delete_element_patch'],
        'confirm_before',
      ),
      revert: exactRevert([
        'create_element_patch',
        'update_element_patch',
        'delete_element_patch',
      ]),
    },
  },
  {
    domain: 'storyline',
    authoredTargets: ['故事线「<名称>」'],
    operations: {
      create: closedWrite(['create_storyline'], ['create_storyline'], 'automatic', 'yjs_sqlite'),
      read: closedRead(['list_storylines', 'read_storyline', 'search_project'], 'yjs_sqlite'),
      update: closedWrite(
        ['update_storyline', 'revise_storyline', 'replace_storyline_body'],
        ['edit_prose_file', 'update_storyline'],
        'automatic',
        'yjs_sqlite',
      ),
      delete: closedWrite(['delete_storyline'], ['delete_storyline'], 'confirm_before', 'yjs_sqlite'),
      revert: exactRevert(
        ['create_storyline', 'edit_prose_file', 'update_storyline', 'delete_storyline'],
        'yjs_sqlite',
      ),
    },
  },
  {
    domain: 'category',
    authoredTargets: ['要素分类「<名称>」'],
    operations: {
      create: closedWrite(['create_element_category'], ['create_category'], 'automatic', 'yjs_sqlite'),
      read: closedRead(['list_element_categories', 'read_element_category', 'search_project'], 'yjs_sqlite'),
      update: closedWrite(
        ['update_element_category', 'replace_element_category_body'],
        ['edit_prose_file', 'update_category'],
        'automatic',
        'yjs_sqlite',
      ),
      delete: closedWrite(['delete_element_category'], ['delete_category'], 'confirm_before', 'yjs_sqlite'),
      revert: exactRevert(
        ['create_category', 'edit_prose_file', 'update_category', 'delete_category'],
        'yjs_sqlite',
      ),
    },
  },
  {
    domain: 'comment_todo',
    authoredTargets: ['批注或待办「<handle>」'],
    operations: {
      create: closedWrite(['create_comment'], ['create_comment'], 'automatic'),
      read: closedRead(['list_comments']),
      update: closedWrite(['update_comment'], ['update_comment'], 'automatic'),
      delete: closedWrite(['delete_comment'], ['delete_comment'], 'confirm_before'),
      revert: exactRevert(['create_comment', 'update_comment', 'delete_comment']),
    },
  },
  {
    domain: 'relation_type',
    authoredTargets: ['关系类型「<名称>」'],
    operations: {
      create: closedWrite(['create_relation_type'], ['create_relation_type'], 'automatic'),
      read: closedRead(['list_relation_types']),
      update: closedWrite(['update_relation_type'], ['update_relation_type'], 'automatic'),
      delete: closedWrite(
        ['delete_relation_type'],
        ['delete_relation_type'],
        'confirm_before',
      ),
      revert: exactRevert([
        'create_relation_type',
        'update_relation_type',
        'delete_relation_type',
      ]),
    },
  },
  {
    domain: 'entity_relation',
    authoredTargets: ['实体关系「<handle>」'],
    operations: {
      create: closedWrite(['create_relation'], ['add_relation'], 'automatic'),
      read: closedRead(['list_relations', 'list_entity_relations']),
      update: closedWrite(['update_relation'], ['assign_relation_type'], 'automatic'),
      delete: closedWrite(['delete_relation'], ['remove_relation'], 'confirm_before'),
      revert: exactRevert(['add_relation', 'assign_relation_type', 'remove_relation']),
    },
  },
  {
    domain: 'storyline_membership',
    authoredTargets: ['故事线「<名称>」章节关系'],
    operations: {
      create: closedWrite(
        ['add_chapter_to_storyline', 'set_chapter_primary_storyline'],
        ['set_storyline_membership'],
        'automatic',
      ),
      read: closedRead(['read_storyline']),
      update: closedWrite(
        ['set_chapter_primary_storyline', 'replace_storyline_chapters'],
        ['set_storyline_membership'],
        'automatic',
      ),
      delete: closedWrite(
        ['remove_chapter_from_storyline', 'replace_storyline_chapters'],
        ['set_storyline_membership'],
        'confirm_before',
      ),
      revert: exactRevert(['set_storyline_membership']),
    },
  },
  {
    domain: 'agent_memory',
    authoredTargets: ['项目记忆', '项目记忆「<memoryId>」'],
    operations: {
      create: closedWrite(['create_project_memory'], ['remember'], 'automatic'),
      read: closedRead(['list_project_memory']),
      update: closedWrite(['update_project_memory'], ['update_memory'], 'automatic'),
      delete: closedWrite(['delete_project_memory'], ['forget'], 'automatic'),
      revert: exactRevert(['remember', 'update_memory', 'forget']),
    },
  },
  {
    domain: 'material',
    authoredTargets: ['素材「<标题>」', '笔记「<标题>」'],
    operations: {
      create: closedWrite(['create_material_note'], [], 'automatic'),
      read: closedRead(['list_materials', 'read_material', 'view_material'], 'yjs_sqlite'),
      update: closedWrite(
        ['update_material', 'revise_material_note', 'replace_material_note_body'],
        [],
        'automatic',
        'yjs_sqlite',
      ),
      delete: notApplicable,
      revert: exactRevert([], 'yjs_sqlite'),
    },
  },
  {
    domain: 'material_folder',
    authoredTargets: ['素材文件夹「<路径>」'],
    operations: {
      create: closedWrite(['create_material_folder'], [], 'automatic'),
      read: closedRead(['list_materials']),
      update: closedWrite(['update_material_folder'], [], 'automatic'),
      delete: closedWrite(['delete_material_folder'], [], 'confirm_before'),
      revert: exactRevert([]),
    },
  },
  {
    domain: 'act',
    authoredTargets: ['幕「<名称>」'],
    operations: {
      create: closedWrite(['create_act'], [], 'automatic'),
      read: closedRead(['read_book_structure', 'list_chapters']),
      update: closedWrite(['update_act'], [], 'automatic'),
      delete: closedWrite(['delete_act'], [], 'confirm_before'),
      revert: exactRevert([]),
    },
  },
  {
    domain: 'book_order',
    authoredTargets: ['章节「<名称>」的阅读位置'],
    operations: {
      create: notApplicable,
      read: closedRead(['read_book_structure', 'list_chapters']),
      update: closedWrite(['move_chapter'], [], 'automatic'),
      delete: notApplicable,
      revert: exactRevert([]),
    },
  },
  {
    domain: 'timeline',
    authoredTargets: ['叙事时间线位置', '时间刻度「<名称>」'],
    operations: {
      create: closedWrite(['create_timeline_marker', 'set_timeline_position'], [], 'automatic'),
      read: closedRead(['read_book_structure']),
      update: closedWrite(['update_timeline_marker', 'set_timeline_position'], [], 'automatic'),
      delete: closedWrite(['delete_timeline_marker', 'set_timeline_position'], [], 'confirm_before'),
      revert: exactRevert([]),
    },
  },
  {
    domain: 'plot_grid',
    authoredTargets: ['章节「<名称>」的情节表'],
    operations: {
      create: closedWrite(['write_plot_grid'], [], 'automatic'),
      read: closedRead(['read_plot_grid', 'read_book_structure']),
      update: closedWrite(['write_plot_grid'], [], 'automatic'),
      delete: closedWrite(['write_plot_grid'], [], 'automatic'),
      revert: exactRevert([]),
    },
  },
  {
    domain: 'project_facts',
    authoredTargets: ['项目事实'],
    operations: {
      create: notApplicable,
      read: closedRead(['get_project_facts']),
      update: closedWrite(['update_project_facts'], ['update_project_facts'], 'automatic'),
      delete: notApplicable,
      revert: exactRevert(['update_project_facts']),
    },
  },
] as const;

export function isDriftingWorkspaceCommandName(
  value: string,
): value is DriftingWorkspaceCommandName {
  return (DRIFTING_WORKSPACE_COMMAND_NAMES as readonly string[]).includes(value);
}
