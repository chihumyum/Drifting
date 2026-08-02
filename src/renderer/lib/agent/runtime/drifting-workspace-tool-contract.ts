/**
 * Pure capability contract for the model-facing Drifting workspace.
 *
 * Keep this module free of renderer/database imports so documentation and
 * headless capability tooling can load the exact production names in Node.
 */
export const DRIFTING_WORKSPACE_READ_TOOLS = [
  'list_files',
  'read_file',
  'grep',
] as const;

export const DRIFTING_WORKSPACE_EDIT_TOOL = 'edit_file' as const;
export const DRIFTING_WORKSPACE_WRITE_TOOL = 'write_file' as const;
export const DRIFTING_WORKSPACE_DELETE_TOOL = 'delete_file' as const;

export const DRIFTING_WORKSPACE_WRITE_TOOLS = [
  DRIFTING_WORKSPACE_EDIT_TOOL,
  DRIFTING_WORKSPACE_WRITE_TOOL,
  DRIFTING_WORKSPACE_DELETE_TOOL,
] as const;

export const DRIFTING_WORKSPACE_PROVIDER_TOOLS = [
  ...DRIFTING_WORKSPACE_READ_TOOLS,
  ...DRIFTING_WORKSPACE_WRITE_TOOLS,
] as const;

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
] as const;

export type DriftingWorkspaceReadToolName =
  (typeof DRIFTING_WORKSPACE_READ_TOOLS)[number];
export type DriftingWorkspaceProviderToolName =
  (typeof DRIFTING_WORKSPACE_PROVIDER_TOOLS)[number];
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
    | 'storyline'
    | 'category'
    | 'comment_todo'
    | 'entity_relation'
    | 'storyline_membership'
    | 'agent_memory'
    | 'project_facts';
  workspacePaths: readonly string[];
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
  hiddenCommands: readonly DriftingWorkspaceCommandName[],
  approval: DriftingDomainCrudOperationContract['approval'],
  authority: DriftingDomainCrudOperationContract['authority'] = 'sqlite',
): DriftingDomainCrudOperationContract => ({
  status: 'closed',
  providerTools: [
    DRIFTING_WORKSPACE_EDIT_TOOL,
    DRIFTING_WORKSPACE_WRITE_TOOL,
    DRIFTING_WORKSPACE_DELETE_TOOL,
  ],
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
 * Executable product lifecycle matrix behind the small filesystem-like model
 * surface. `revert: closed` means the same hidden commands have immutable
 * receipts plus a guarded exact inverse; it does not advertise a second model
 * tool or pre-empt the later user checkpoint/rewind milestone.
 */
export const DRIFTING_DOMAIN_CRUD_CONTRACTS: readonly DriftingDomainCrudContract[] = [
  {
    domain: 'node',
    workspacePaths: ['/chapters/<chapter>/**', '/drifts/<drift>/**'],
    operations: {
      create: closedWrite(['create_node'], 'automatic', 'yjs_sqlite'),
      read: closedRead(['list_files', 'read_file', 'grep'], 'yjs_sqlite'),
      update: closedWrite(
        ['edit_prose_file', 'rename_node', 'set_node_summary'],
        'automatic_or_inline_review',
        'yjs_sqlite',
      ),
      delete: closedWrite(['delete_node'], 'confirm_before', 'yjs_sqlite'),
      revert: exactRevert(
        ['create_node', 'edit_prose_file', 'rename_node', 'set_node_summary', 'delete_node'],
        'yjs_sqlite',
      ),
    },
  },
  {
    domain: 'element',
    workspacePaths: ['/elements/<category>/<element>/**'],
    operations: {
      create: closedWrite(['create_element'], 'automatic', 'yjs_sqlite'),
      read: closedRead(['list_files', 'read_file', 'grep'], 'yjs_sqlite'),
      update: closedWrite(
        ['edit_prose_file', 'update_element'],
        'automatic_or_inline_review',
        'yjs_sqlite',
      ),
      delete: closedWrite(['delete_element'], 'confirm_before', 'yjs_sqlite'),
      revert: exactRevert(
        ['create_element', 'edit_prose_file', 'update_element', 'delete_element'],
        'yjs_sqlite',
      ),
    },
  },
  {
    domain: 'storyline',
    workspacePaths: ['/storylines/<storyline>/**'],
    operations: {
      create: closedWrite(['create_storyline'], 'automatic', 'yjs_sqlite'),
      read: closedRead(['list_files', 'read_file', 'grep'], 'yjs_sqlite'),
      update: closedWrite(
        ['edit_prose_file', 'update_storyline'],
        'automatic_or_inline_review',
        'yjs_sqlite',
      ),
      delete: closedWrite(['delete_storyline'], 'confirm_before', 'yjs_sqlite'),
      revert: exactRevert(
        ['create_storyline', 'edit_prose_file', 'update_storyline', 'delete_storyline'],
        'yjs_sqlite',
      ),
    },
  },
  {
    domain: 'category',
    workspacePaths: ['/categories/<category>/**'],
    operations: {
      create: closedWrite(['create_category'], 'automatic', 'yjs_sqlite'),
      read: closedRead(['list_files', 'read_file', 'grep'], 'yjs_sqlite'),
      update: closedWrite(
        ['edit_prose_file', 'update_category'],
        'automatic_or_inline_review',
        'yjs_sqlite',
      ),
      delete: closedWrite(['delete_category'], 'confirm_before', 'yjs_sqlite'),
      revert: exactRevert(
        ['create_category', 'edit_prose_file', 'update_category', 'delete_category'],
        'yjs_sqlite',
      ),
    },
  },
  {
    domain: 'comment_todo',
    workspacePaths: ['/comments/<commentId>.json'],
    operations: {
      create: closedWrite(['create_comment'], 'automatic'),
      read: closedRead(['list_files', 'read_file']),
      update: closedWrite(['update_comment'], 'automatic'),
      delete: closedWrite(['delete_comment'], 'confirm_before'),
      revert: exactRevert(['create_comment', 'update_comment', 'delete_comment']),
    },
  },
  {
    domain: 'entity_relation',
    workspacePaths: ['/relations/<relationId>.json'],
    operations: {
      create: closedWrite(['add_relation'], 'confirm_before'),
      read: closedRead(['list_files', 'read_file']),
      update: closedWrite(['update_relation_kind'], 'confirm_before'),
      delete: closedWrite(['remove_relation'], 'confirm_before'),
      revert: exactRevert(['add_relation', 'update_relation_kind', 'remove_relation']),
    },
  },
  {
    domain: 'storyline_membership',
    workspacePaths: ['/storylines/<storyline>/chapters.json'],
    operations: {
      create: closedWrite(['set_storyline_membership'], 'confirm_before'),
      read: closedRead(['list_files', 'read_file']),
      update: closedWrite(['set_storyline_membership'], 'confirm_before'),
      delete: closedWrite(['set_storyline_membership'], 'confirm_before'),
      revert: exactRevert(['set_storyline_membership']),
    },
  },
  {
    domain: 'agent_memory',
    workspacePaths: ['/memory.json', '/memory/<memoryId>.json'],
    operations: {
      create: closedWrite(['remember'], 'automatic'),
      read: closedRead(['list_files', 'read_file']),
      update: closedWrite(['update_memory'], 'automatic'),
      delete: closedWrite(['forget'], 'confirm_before'),
      revert: exactRevert(['remember', 'update_memory', 'forget']),
    },
  },
  {
    domain: 'project_facts',
    workspacePaths: ['/project/facts.json'],
    operations: {
      create: notApplicable,
      read: closedRead(['read_file']),
      update: closedWrite(['update_project_facts'], 'automatic'),
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
