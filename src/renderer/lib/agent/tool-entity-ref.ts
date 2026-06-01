/**
 * Map an agent tool call to the entity it touched — the single source of truth
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

export interface ToolEntityRef {
  entityType: ActivityEntityType;
  id: string;
  op: ActivityOp;
}

/** Tools whose target is a single entity, keyed by tool name → {entityType, op}. */
const ARG_TOOLS: Record<string, { entityType: ActivityEntityType; op: ActivityOp }> = {
  // node (chapter / drift)
  read_chapter: { entityType: 'node', op: 'read' },
  get_chapter_context: { entityType: 'node', op: 'read' },
  read_block: { entityType: 'node', op: 'read' },
  lookup_block: { entityType: 'node', op: 'read' },
  rename_chapter: { entityType: 'node', op: 'write' },
  set_node_summary: { entityType: 'node', op: 'write' },
  edit_block: { entityType: 'node', op: 'write' },
  edit_blocks: { entityType: 'node', op: 'write' },
  append_paragraph: { entityType: 'node', op: 'write' },
  remove_blocks: { entityType: 'node', op: 'write' },
  replace_block_range: { entityType: 'node', op: 'write' },
  insert_blocks: { entityType: 'node', op: 'write' },
  // element
  read_element: { entityType: 'element', op: 'read' },
  get_element_patches: { entityType: 'element', op: 'read' },
  update_element: { entityType: 'element', op: 'write' },
  delete_element: { entityType: 'element', op: 'delete' },
  // storyline
  get_storyline: { entityType: 'storyline', op: 'read' },
  update_storyline: { entityType: 'storyline', op: 'write' },
  // category
  update_category: { entityType: 'category', op: 'write' },
};

// The arg field that carries an entity's name-or-id, by entity kind. Accepts the
// new clear names (chapter/element/…) and the legacy *Id names, so it's robust
// to either tool-schema spelling.
const REF_FIELDS: Record<ActivityEntityType, string[]> = {
  node: ['chapter', 'nodeId'],
  element: ['element', 'elementId'],
  storyline: ['storyline', 'storylineId'],
  category: ['category', 'categoryId'],
};
function refValue(entityType: ActivityEntityType, args: Record<string, unknown>): string | undefined {
  for (const f of REF_FIELDS[entityType]) {
    const v = args[f];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** create_* tools — the new entity's id comes from the result, not the args. */
const CREATE_TOOLS: Record<string, ActivityEntityType> = {
  create_node: 'node',
  create_element: 'element',
  create_storyline: 'storyline',
  create_category: 'category',
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
  // set_summary is addressed by (targetKind, targetId/target), not a flat field.
  if (name === 'set_summary') {
    const raw = typeof args.target === 'string' ? args.target : String(args.targetId ?? '');
    if (!raw) return null;
    const tk = String(args.targetKind ?? '');
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
    return id ? { entityType, id, op: 'write' } : null;
  }
  const arg = ARG_TOOLS[name];
  if (arg) {
    const raw = refValue(arg.entityType, args);
    if (raw) {
      const id = resolveEntityId(arg.entityType, raw);
      if (id) return { entityType: arg.entityType, id, op: arg.op };
    }
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
