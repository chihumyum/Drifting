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

/** Tools whose target is a single entity, keyed by tool name → {entityType, op}. */
const ARG_TOOLS: Record<string, { entityType: ActivityEntityType; op: ActivityOp }> = {
  // node (chapter / drift)
  read_node: { entityType: 'node', op: 'read' },
  get_node_context: { entityType: 'node', op: 'read' },
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
  // storyline
  get_storyline: { entityType: 'storyline', op: 'read' },
  update_storyline: { entityType: 'storyline', op: 'write' },
  // category
  update_category: { entityType: 'category', op: 'write' },
};

// The arg field that carries an entity's name, by entity kind. `node` is the
// neutral spelling (chapter|drift); `chapter` is the chapter-only spelling.
// Legacy *Id names are accepted last so it's robust to any tool-schema spelling.
const REF_FIELDS: Record<ActivityEntityType, string[]> = {
  node: ['node', 'chapter', 'nodeId'],
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
      return 'category';
    default:
      return 'node'; // node | chapter | drift | (missing)
  }
}

// Tools that change the entity summary (not block prose).
const SUMMARY_TOOLS = new Set(['set_node_summary', 'set_summary']);
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
    return id ? { entityType, id, op: 'write', spots: deriveSpots(name, 'write', resultText) } : null;
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
    const entityType = KIND_SELECTABLE_TOOLS.has(name) ? kindFromArgs(args) : arg.entityType;
    const raw = refValue(entityType, args);
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
    const id = createdIdFromResult(resultText, createKind);
    if (id) return { entityType: createKind, id, op: 'create', spots: deriveSpots(name, 'create', resultText) };
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
