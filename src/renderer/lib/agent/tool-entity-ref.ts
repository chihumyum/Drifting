/**
 * Map an agent tool call to the entity it touched — the single source of truth
 * shared by the activity indicators (#17) and the result links (#18), so the two
 * features can't drift apart.
 */
export type ActivityEntityType = 'node' | 'element' | 'storyline' | 'category';
export type ActivityOp = 'read' | 'write' | 'create' | 'delete';

export interface ToolEntityRef {
  entityType: ActivityEntityType;
  id: string;
  op: ActivityOp;
}

/** Tools whose target id is a plain arg field. */
const ARG_TOOLS: Record<string, { field: string; entityType: ActivityEntityType; op: ActivityOp }> = {
  // node (chapter / drift)
  read_chapter: { field: 'nodeId', entityType: 'node', op: 'read' },
  get_chapter_context: { field: 'nodeId', entityType: 'node', op: 'read' },
  read_block: { field: 'nodeId', entityType: 'node', op: 'read' },
  lookup_block: { field: 'nodeId', entityType: 'node', op: 'read' },
  rename_chapter: { field: 'nodeId', entityType: 'node', op: 'write' },
  set_node_summary: { field: 'nodeId', entityType: 'node', op: 'write' },
  edit_block: { field: 'nodeId', entityType: 'node', op: 'write' },
  edit_blocks: { field: 'nodeId', entityType: 'node', op: 'write' },
  append_paragraph: { field: 'nodeId', entityType: 'node', op: 'write' },
  remove_blocks: { field: 'nodeId', entityType: 'node', op: 'write' },
  replace_block_range: { field: 'nodeId', entityType: 'node', op: 'write' },
  insert_blocks: { field: 'nodeId', entityType: 'node', op: 'write' },
  // element
  read_element: { field: 'elementId', entityType: 'element', op: 'read' },
  get_element_patches: { field: 'elementId', entityType: 'element', op: 'read' },
  update_element: { field: 'elementId', entityType: 'element', op: 'write' },
  delete_element: { field: 'elementId', entityType: 'element', op: 'delete' },
  // storyline
  get_storyline: { field: 'storylineId', entityType: 'storyline', op: 'read' },
  update_storyline: { field: 'storylineId', entityType: 'storyline', op: 'write' },
  // category
  update_category: { field: 'categoryId', entityType: 'category', op: 'write' },
};

/** create_* tools — the new entity's id comes from the result, not the args. */
const CREATE_TOOLS: Record<string, ActivityEntityType> = {
  create_node: 'node',
  create_element: 'element',
  create_storyline: 'storyline',
  create_category: 'category',
};

/** Pull `created.id` (or `id`) out of a tool result's JSON text. */
function idFromResult(resultText: string | undefined): string | null {
  if (!resultText) return null;
  try {
    const parsed = JSON.parse(resultText) as { created?: { id?: unknown }; id?: unknown };
    const id = parsed.created?.id ?? parsed.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
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
  // set_summary is addressed by (targetKind, targetId), not a flat field.
  if (name === 'set_summary') {
    const id = typeof args.targetId === 'string' ? args.targetId : '';
    if (!id) return null;
    const tk = String(args.targetKind ?? '');
    const entityType: ActivityEntityType | null =
      tk === 'element'
        ? 'element'
        : tk === 'storyline'
          ? 'storyline'
          : tk === 'node' || tk === 'chapter' || tk === 'drift'
            ? 'node'
            : null;
    return entityType ? { entityType, id, op: 'write' } : null;
  }
  const arg = ARG_TOOLS[name];
  if (arg) {
    const id = args[arg.field];
    if (typeof id === 'string' && id) return { entityType: arg.entityType, id, op: arg.op };
    return null;
  }
  const createKind = CREATE_TOOLS[name];
  if (createKind) {
    const id = idFromResult(resultText);
    if (id) return { entityType: createKind, id, op: 'create' };
  }
  return null;
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
    const ref = toolEntityRef(m.name, m.input, m.result);
    // Reads have nothing to jump to; deletes point at a now-gone entity.
    if (!ref || ref.op === 'read' || ref.op === 'delete') continue;
    const key = entityKey(ref.entityType, ref.id);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}
