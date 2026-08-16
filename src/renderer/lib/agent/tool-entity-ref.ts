/**
 * Map an agent tool call to the entities it touched — the single source of truth
 * shared by the activity indicators (#17) and the result links (#18), so the two
 * features can't drift apart.
 *
 * The agent addresses entities by NAME now, so the raw tool input carries a name
 * (or an id) — we resolve it to the real entity id here so the activity store
 * and the result chips (which key/look-up by id) match.
 */
import { useDataStore } from '../../store/data-store';

export type ActivityEntityType = 'node' | 'element' | 'storyline' | 'category';
export type ActivityOp = 'read' | 'write' | 'create' | 'delete';

/**
 * Which part of the entity a write touched, so the agent-change indicator (#17)
 * can highlight it and clear once the user has actually read THAT spot:
 *   - summary    → the entity's summary field changed
 *   - blocks     → these prose block uuids were edited/created (viewable anchors)
 *   - structural → a change with no single viewable anchor (blocks removed, a
 *                  whole-body rewrite, a rename, or a fresh create) — cleared
 *                  when the entity is simply opened.
 */
export interface ChangeSpots {
  summary?: boolean;
  blocks?: string[];
  structural?: boolean;
}

export interface ToolEntityRef {
  entityType: ActivityEntityType;
  id: string;
  op: ActivityOp;
  spots?: ChangeSpots;
}

function uniqueEntityRefs(refs: readonly ToolEntityRef[]): ToolEntityRef[] {
  const byKey = new Map<string, ToolEntityRef>();
  for (const ref of refs) byKey.set(`${ref.entityType}:${ref.id}`, ref);
  return [...byKey.values()];
}

/** Tools whose target is a single entity, keyed by tool name → {entityType, op}. */
const ARG_TOOLS: Record<string, { entityType: ActivityEntityType; op: ActivityOp }> = {
  // node (chapter / drift)
  read_node: { entityType: 'node', op: 'read' },
  read_block: { entityType: 'node', op: 'read' },
  lookup_block: { entityType: 'node', op: 'read' },
  rename_node: { entityType: 'node', op: 'write' },
  set_node_summary: { entityType: 'node', op: 'write' },
  edit_block: { entityType: 'node', op: 'write' },
  edit_blocks: { entityType: 'node', op: 'write' },
  append_paragraph: { entityType: 'node', op: 'write' },
  remove_blocks: { entityType: 'node', op: 'write' },
  replace_block_range: { entityType: 'node', op: 'write' },
  insert_blocks: { entityType: 'node', op: 'write' },
  read_chapter: { entityType: 'node', op: 'read' },
  read_inspiration: { entityType: 'node', op: 'read' },
  rename_chapter: { entityType: 'node', op: 'write' },
  rename_inspiration: { entityType: 'node', op: 'write' },
  set_chapter_summary: { entityType: 'node', op: 'write' },
  set_inspiration_summary: { entityType: 'node', op: 'write' },
  revise_chapter: { entityType: 'node', op: 'write' },
  revise_inspiration: { entityType: 'node', op: 'write' },
  replace_chapter_body: { entityType: 'node', op: 'write' },
  replace_inspiration_body: { entityType: 'node', op: 'write' },
  delete_chapter: { entityType: 'node', op: 'delete' },
  delete_inspiration: { entityType: 'node', op: 'delete' },
  // element
  read_element: { entityType: 'element', op: 'read' },
  get_element_patches: { entityType: 'element', op: 'read' },
  // Creating a patch is a write to its owning element (lights the element's "M"
  // + makes it a 本轮改动 link). Resolves the element from args.element (a NAME).
  create_element_patch: { entityType: 'element', op: 'write' },
  update_element: { entityType: 'element', op: 'write' },
  delete_element: { entityType: 'element', op: 'delete' },
  set_element_body: { entityType: 'element', op: 'write' },
  // whole-body set — entityType resolved from args.kind (kind-selectable below)
  set_entity_body: { entityType: 'element', op: 'write' },
  revise_element: { entityType: 'element', op: 'write' },
  replace_element_body: { entityType: 'element', op: 'write' },
  // storyline
  get_storyline: { entityType: 'storyline', op: 'read' },
  update_storyline: { entityType: 'storyline', op: 'write' },
  read_storyline: { entityType: 'storyline', op: 'read' },
  revise_storyline: { entityType: 'storyline', op: 'write' },
  replace_storyline_body: { entityType: 'storyline', op: 'write' },
  delete_storyline: { entityType: 'storyline', op: 'delete' },
  add_chapter_to_storyline: { entityType: 'storyline', op: 'write' },
  remove_chapter_from_storyline: { entityType: 'storyline', op: 'write' },
  set_chapter_primary_storyline: { entityType: 'storyline', op: 'write' },
  replace_storyline_chapters: { entityType: 'storyline', op: 'write' },
  // category
  update_category: { entityType: 'category', op: 'write' },
  read_element_category: { entityType: 'category', op: 'read' },
  update_element_category: { entityType: 'category', op: 'write' },
  replace_element_category_body: { entityType: 'category', op: 'write' },
  delete_element_category: { entityType: 'category', op: 'delete' },
};

// The arg field that carries an entity's name, by entity kind. `node` is the
// neutral spelling (chapter|drift); `chapter` is the chapter-only spelling.
// Legacy *Id names are accepted last so it's robust to any tool-schema spelling.
const REF_FIELDS: Record<ActivityEntityType, string[]> = {
  node: ['node', 'chapter', 'inspiration', 'nodeId'],
  element: ['element', 'elementId'],
  storyline: ['storyline', 'storylineId'],
  category: ['category', 'categoryId'],
};
function refValue(entityType: ActivityEntityType, args: Record<string, unknown>): string | undefined {
  // The neutral `entity` arg (the kind-selectable block-prose tools) takes
  // priority over the kind-specific spellings.
  const neutral = args['entity'];
  if (typeof neutral === 'string' && neutral.trim()) return neutral;
  for (const f of REF_FIELDS[entityType]) {
    const v = args[f];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/**
 * Block-prose tools take a `kind` selector (node — default — / element /
 * storyline / category) so they can edit any prose entity's body. For these, the
 * touched entityType comes from args.kind, NOT the hardcoded ARG_TOOLS entry.
 */
const KIND_SELECTABLE_TOOLS = new Set([
  'read_node',
  'read_block',
  'lookup_block',
  'edit_block',
  'edit_blocks',
  'append_paragraph',
  'remove_blocks',
  'replace_block_range',
  'insert_blocks',
  'set_entity_body',
]);
function kindFromArgs(args: Record<string, unknown>): ActivityEntityType {
  switch (typeof args.kind === 'string' ? args.kind : '') {
    case 'element':
      return 'element';
    case 'storyline':
      return 'storyline';
    case 'category':
    case 'element_category':
      return 'category';
    default:
      return 'node'; // node | chapter | drift | (missing)
  }
}

// Tools that change the entity summary (not block prose).
const SUMMARY_TOOLS = new Set([
  'set_node_summary',
  'set_summary',
  'set_chapter_summary',
  'set_inspiration_summary',
]);
// Tools that edit/create viewable prose blocks — their result carries blockIds.
const BLOCK_EDIT_TOOLS = new Set([
  'edit_block',
  'edit_blocks',
  'append_paragraph',
  'insert_blocks',
  'replace_block_range',
]);

/** Pull the resolved/created block uuids a prose handler reports in its result. */
function blockIdsFromResult(resultText: string | undefined): string[] {
  if (!resultText) return [];
  try {
    const parsed = JSON.parse(resultText) as { blockIds?: unknown };
    if (Array.isArray(parsed.blockIds)) {
      return parsed.blockIds.filter((b): b is string => typeof b === 'string' && b.length > 0);
    }
  } catch {
    /* not JSON / no blockIds */
  }
  return [];
}

/**
 * Which spot(s) a write/create touched. Reads/deletes get none (no breathing
 * dot). Block edits whose result lacks usable uuids (the no-Yjs JSON fallback)
 * degrade to `structural`, as do removals, rewrites, renames and creates — they
 * have no single anchor, so the dot clears when the entity is opened.
 */
function deriveSpots(name: string, op: ActivityOp, resultText?: string): ChangeSpots | undefined {
  if (op === 'read' || op === 'delete') return undefined;
  if (SUMMARY_TOOLS.has(name)) return { summary: true };
  if (BLOCK_EDIT_TOOLS.has(name)) {
    const blocks = blockIdsFromResult(resultText);
    return blocks.length ? { blocks } : { structural: true };
  }
  return { structural: true };
}

/** create_* tools — the new entity's id comes from the result, not the args. */
const CREATE_TOOLS: Record<string, ActivityEntityType> = {
  create_node: 'node',
  create_chapter: 'node',
  create_inspiration: 'node',
  create_element: 'element',
  create_storyline: 'storyline',
  create_category: 'category',
  create_element_category: 'category',
};

/**
 * Resolve the value the agent passed (a NAME or an id) to the real entity id,
 * by matching against the current project's entities. Returns null if unknown
 * (e.g. a just-deleted entity).
 */
function resolveEntityId(entityType: ActivityEntityType, nameOrId: string): string | null {
  const r = nameOrId.trim();
  if (!r) return null;
  const low = r.toLowerCase();
  const s = useDataStore.getState();
  switch (entityType) {
    case 'node': {
      const m =
        s.bookNodes.find((n) => n.id === r) ??
        s.bookNodes.find((n) => n.title.trim().toLowerCase() === low);
      return m?.id ?? null;
    }
    case 'element': {
      const m =
        s.bookElements.find((e) => e.id === r) ??
        s.bookElements.find((e) => [e.name, ...e.aliases].some((x) => x.trim().toLowerCase() === low));
      return m?.id ?? null;
    }
    case 'storyline': {
      const m =
        s.storylines.find((x) => x.id === r) ??
        s.storylines.find((x) => x.name.trim().toLowerCase() === low);
      return m?.id ?? null;
    }
    case 'category': {
      const m =
        s.bookElementCategories.find((x) => x.id === r) ??
        s.bookElementCategories.find((x) => x.name.trim().toLowerCase() === low);
      return m?.id ?? null;
    }
    default:
      return null;
  }
}

function activityEntityTypeFromKind(value: unknown): ActivityEntityType | null {
  switch (typeof value === 'string' ? value.trim() : '') {
    case 'node':
    case 'chapter':
    case 'drift':
    case 'inspiration':
      return 'node';
    case 'element':
      return 'element';
    case 'storyline':
      return 'storyline';
    case 'category':
      return 'category';
    default:
      return null;
  }
}

function activityRef(
  kind: unknown,
  nameOrId: unknown,
  spots: ChangeSpots = { structural: true },
): ToolEntityRef | null {
  const entityType = activityEntityTypeFromKind(kind);
  const raw = typeof nameOrId === 'string' ? nameOrId.trim() : '';
  if (!entityType || !raw) return null;
  const id = resolveEntityId(entityType, raw);
  return id ? { entityType, id, op: 'write', spots } : null;
}

function storedCommentTargetRef(commentId: unknown): ToolEntityRef | null {
  const id = typeof commentId === 'string' ? commentId.trim() : '';
  if (!id) return null;
  const comment = useDataStore.getState().comments.find((candidate) => candidate.id === id);
  if (!comment?.targetKind || !comment.targetId) return null;
  return activityRef(comment.targetKind, comment.targetId);
}

function relationEndpointRefs(args: Record<string, unknown>): ToolEntityRef[] {
  const relationId = typeof args.relationId === 'string' ? args.relationId.trim() : '';
  if (relationId) {
    const relation = useDataStore
      .getState()
      .entityRelations.find((candidate) => candidate.id === relationId);
    if (!relation) return [];
    return uniqueEntityRefs(
      [
        activityRef(relation.fromKind, relation.fromId),
        activityRef(relation.toKind, relation.toId),
      ].filter((ref): ref is ToolEntityRef => ref !== null),
    );
  }

  const from = activityRef(args.fromKind ?? args.fromType, args.from ?? args.fromName);
  const to = activityRef(args.toKind ?? args.toType, args.to ?? args.toName);
  return uniqueEntityRefs(
    [from, to].filter((ref): ref is ToolEntityRef => ref !== null),
  );
}

/**
 * Pull the created entity's NAME out of a create tool's result, then resolve it
 * to an id. create_* tools return the new entity by name keyed on its kind —
 * e.g. create_node → {node:"…"}, create_element → {element:"…"} — matching the
 * name-only tool contract; we resolve it here for the id-keyed activity store.
 */
function createdIdFromResult(
  resultText: string | undefined,
  entityType: ActivityEntityType,
): string | null {
  if (!resultText) return null;
  try {
    const parsed = JSON.parse(resultText) as Record<string, unknown>;
    const name = parsed[entityType];
    if (typeof name !== 'string' || !name) return null;
    return resolveEntityId(entityType, name);
  } catch {
    return null;
  }
}

function decodedWorkspaceSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function workspaceResultRecord(resultText: string | undefined): Record<string, unknown> | null {
  if (!resultText) return null;
  try {
    const parsed = JSON.parse(resultText) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Resolve the runtime's private storage identity back to the sidebar entity it owns. */
function workspaceEntityFromPath(path: string): Pick<ToolEntityRef, 'entityType' | 'id'> | null {
  const parts = path
    .trim()
    .replace(/^\/+|\/+$/gu, '')
    .split('/')
    .map(decodedWorkspaceSegment);
  const root = parts[0];
  const state = useDataStore.getState();

  if ((root === 'chapters' || root === 'drifts') && parts.length >= 3) {
    const kind = root === 'chapters' ? 'chapter' : 'drift';
    const title = parts[1]?.trim().toLowerCase();
    const node = state.bookNodes.find(
      (candidate) =>
        candidate.kind === kind && candidate.title.trim().toLowerCase() === title,
    );
    return node ? { entityType: 'node', id: node.id } : null;
  }
  if (root === 'elements' && parts.length >= 4) {
    const name = parts[2]?.trim().toLowerCase();
    const element = state.bookElements.find(
      (candidate) => candidate.name.trim().toLowerCase() === name,
    );
    return element ? { entityType: 'element', id: element.id } : null;
  }
  if (root === 'storylines' && parts.length >= 3) {
    const name = parts[1]?.trim().toLowerCase();
    const storyline = state.storylines.find(
      (candidate) => candidate.name.trim().toLowerCase() === name,
    );
    return storyline ? { entityType: 'storyline', id: storyline.id } : null;
  }
  if (root === 'categories' && parts.length >= 3) {
    const name = parts[1]?.trim().toLowerCase();
    const category = state.bookElementCategories.find(
      (candidate) => candidate.name.trim().toLowerCase() === name,
    );
    return category ? { entityType: 'category', id: category.id } : null;
  }
  return null;
}

/**
 * Resolve a tool call to the entity it touched, or null. `resultText` is needed
 * for create_* tools (the id is in the result). Returns op='read'|'write'|'create'.
 */
export function toolEntityRef(
  name: string,
  input: unknown,
  resultText?: string,
): ToolEntityRef | null {
  const args = (input ?? {}) as Record<string, unknown>;
  const preparedCommand =
    args.__workspaceCommand &&
    typeof args.__workspaceCommand === 'object' &&
    !Array.isArray(args.__workspaceCommand)
      ? (args.__workspaceCommand as Record<string, unknown>)
      : null;
  const preparedArguments =
    preparedCommand?.arguments &&
    typeof preparedCommand.arguments === 'object' &&
    !Array.isArray(preparedCommand.arguments)
      ? (preparedCommand.arguments as Record<string, unknown>)
      : null;
  const domainArgs = preparedArguments ? { ...args, ...preparedArguments } : args;
  // set_summary is addressed by (targetKind, targetId/target), not a flat field.
  if (name === 'set_summary') {
    const raw =
      typeof domainArgs.target === 'string'
        ? domainArgs.target
        : String(domainArgs.targetId ?? '');
    if (!raw) return null;
    const tk = String(domainArgs.targetKind ?? '');
    const entityType: ActivityEntityType | null =
      tk === 'element'
        ? 'element'
        : tk === 'storyline'
          ? 'storyline'
          : tk === 'node' || tk === 'chapter' || tk === 'drift'
            ? 'node'
            : null;
    if (!entityType) return null;
    const id = resolveEntityId(entityType, raw);
    return id ? { entityType, id, op: 'write', spots: deriveSpots(name, 'write', resultText) } : null;
  }
  // A comment is its own annotative entity, but the activity surface tracks
  // structural editor destinations. Attribute an anchored create to that
  // target; floating project comments intentionally have no entity ref.
  if (name === 'create_comment') {
    return activityRef(
      domainArgs.targetKind ?? domainArgs.targetType,
      domainArgs.target ?? domainArgs.targetName,
    );
  }
  // Updating/deleting a comment only carries commentId. Resolve its anchored
  // host before the mutation removes or changes the comment; agent-activity-
  // store retains this preflight ref until the result arrives.
  if (name === 'update_comment' || name === 'delete_comment') {
    return storedCommentTargetRef(domainArgs.commentId);
  }
  // A relationship mutates both endpoint entities from the author's point of
  // view. The singular compatibility API returns the first endpoint; activity
  // and turn-result surfaces use toolEntityRefs below to retain both.
  if (
    name === 'create_relation' ||
    name === 'update_relation' ||
    name === 'delete_relation' ||
    name === 'add_relation' ||
    name === 'assign_relation_type' ||
    name === 'remove_relation'
  ) {
    return relationEndpointRefs(domainArgs)[0] ?? null;
  }
  // Patch update/delete carry only a patchId in their ARGS, but return their
  // owning element NAME in the RESULT — surface that as an element write so the
  // cell "M" + 本轮改动 link reflect the change (a soft-delete still modifies the
  // element's patch set, so it's a write, not a delete).
  if (name === 'update_element_patch' || name === 'delete_element_patch') {
    if (!resultText) return null;
    try {
      const parsed = JSON.parse(resultText) as { element?: unknown };
      if (typeof parsed.element === 'string' && parsed.element) {
        const id = resolveEntityId('element', parsed.element);
        if (id) return { entityType: 'element', id, op: 'write', spots: { structural: true } };
      }
    } catch {
      /* not JSON */
    }
    return null;
  }
  const arg = ARG_TOOLS[name];
  if (arg) {
    // Kind-selectable block tools resolve their entityType from args.kind; the
    // rest use their fixed ARG_TOOLS entityType. The op is fixed either way.
    const entityType = KIND_SELECTABLE_TOOLS.has(name)
      ? kindFromArgs(domainArgs)
      : arg.entityType;
    const raw = refValue(entityType, domainArgs);
    if (raw) {
      const id = resolveEntityId(entityType, raw);
      if (id) {
        return { entityType, id, op: arg.op, spots: deriveSpots(name, arg.op, resultText) };
      }
    }
    return null;
  }
  const createKind = CREATE_TOOLS[name];
  if (createKind) {
    const result = workspaceResultRecord(resultText);
    const resultPath = typeof result?.path === 'string' ? result.path : '';
    const pathRef = resultPath ? workspaceEntityFromPath(resultPath) : null;
    if (pathRef) {
      return {
        ...pathRef,
        op: 'create',
        spots: deriveSpots(name, 'create', resultText),
      };
    }
    const id = createdIdFromResult(resultText, createKind);
    if (id) return { entityType: createKind, id, op: 'create', spots: deriveSpots(name, 'create', resultText) };
  }
  return null;
}

/** Resolve every sidebar entity touched by one call. Relations deliberately
 * return both endpoints; every other tool remains a zero-or-one mapping. */
export function toolEntityRefs(
  name: string,
  input: unknown,
  resultText?: string,
): ToolEntityRef[] {
  const args = (input ?? {}) as Record<string, unknown>;
  const preparedCommand =
    args.__workspaceCommand &&
    typeof args.__workspaceCommand === 'object' &&
    !Array.isArray(args.__workspaceCommand)
      ? (args.__workspaceCommand as Record<string, unknown>)
      : null;
  const preparedArguments =
    preparedCommand?.arguments &&
    typeof preparedCommand.arguments === 'object' &&
    !Array.isArray(preparedCommand.arguments)
      ? (preparedCommand.arguments as Record<string, unknown>)
      : null;
  const domainArgs = preparedArguments ? { ...args, ...preparedArguments } : args;
  if (
    name === 'create_relation' ||
    name === 'update_relation' ||
    name === 'delete_relation' ||
    name === 'add_relation' ||
    name === 'assign_relation_type' ||
    name === 'remove_relation'
  ) {
    return relationEndpointRefs(domainArgs);
  }
  const ref = toolEntityRef(name, input, resultText);
  return ref ? [ref] : [];
}

export const entityKey = (entityType: ActivityEntityType, id: string): string => `${entityType}:${id}`;

/**
 * The entities the agent CREATED/EDITED in the latest turn (from the last user
 * message onward), deduped — for the "本轮改动" clickable links (#18). Reads are
 * excluded (links are for things that changed). Tool messages carry name/input/
 * result, so the same toolEntityRef map drives this and the activity store.
 */
export function collectTurnEntityRefs(
  messages: Array<{ kind: string; name?: string; input?: unknown; result?: string; status?: string }>,
): ToolEntityRef[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'user') {
      start = i;
      break;
    }
  }
  const seen = new Set<string>();
  const refs: ToolEntityRef[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.kind !== 'tool' || m.status !== 'ok' || !m.name) continue;
    const mapped = toolEntityRefs(m.name, m.input, m.result);
    // Reads have nothing to jump to; deletes point at a now-gone entity.
    for (const ref of mapped) {
      if (ref.op === 'read' || ref.op === 'delete') continue;
      const key = entityKey(ref.entityType, ref.id);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}
