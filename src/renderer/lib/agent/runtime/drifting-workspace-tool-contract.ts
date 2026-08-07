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
  'list_entity_relations',
  'list_comments',
  'list_author_rules',
  'list_materials',
  'read_material',
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
  'create_comment',
  'update_comment',
  'delete_comment',
  'update_project_facts',
  'create_author_rule',
  'update_author_rule',
  'delete_author_rule',
  'create_element_patch',
  'update_element_patch',
  'delete_element_patch',
] as const;

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
  'update_relation_kind',
  'remove_relation',
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
    | 'inline_review'
    | 'automatic_or_inline_review'
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
    | 'storyline_membership'
    | 'agent_memory'
    | 'project_facts';
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
    authoredTargets: ['章节「<名称>」', '灵感「<名称>」'],
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
        'automatic_or_inline_review',
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
        'automatic_or_inline_review',
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
        'automatic_or_inline_review',
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
        'automatic_or_inline_review',
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
    domain: 'entity_relation',
    authoredTargets: ['实体关系「<handle>」'],
    operations: {
      create: closedWrite(['create_relation'], ['add_relation'], 'automatic'),
      read: closedRead(['list_relations', 'list_entity_relations']),
      update: closedWrite(['update_relation'], ['update_relation_kind'], 'automatic'),
      delete: closedWrite(['delete_relation'], ['remove_relation'], 'confirm_before'),
      revert: exactRevert(['add_relation', 'update_relation_kind', 'remove_relation']),
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
        'automatic_or_inline_review',
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
    authoredTargets: ['作者规则', '作者规则「<handle>」'],
    operations: {
      create: closedWrite(['create_author_rule'], ['remember'], 'automatic'),
      read: closedRead(['list_author_rules']),
      update: closedWrite(['update_author_rule'], ['update_memory'], 'automatic'),
      delete: closedWrite(['delete_author_rule'], ['forget'], 'confirm_before'),
      revert: exactRevert(['remember', 'update_memory', 'forget']),
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
