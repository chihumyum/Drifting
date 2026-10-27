// Task items in a material note's ProseMirror JSON (the `note` profile's
// taskList/taskItem). Shared by the stats tab, the TODO projection and the
// Review panel's note grouping, so they agree on what counts as a task.

export interface NoteTaskItem {
  /** The task item's own block id (block-id extension); null on legacy JSON. */
  blockId: string | null;
  /** The TODO this item is linked to, if any. */
  todoId: string | null;
  checked: boolean;
  /** Plain text of the item's own paragraphs, without nested sub-tasks. */
  text: string;
}

interface JsonNode {
  type?: unknown;
  attrs?: Record<string, unknown>;
  content?: unknown;
  text?: unknown;
}

function ownText(node: JsonNode): string {
  const parts: string[] = [];
  const walk = (current: JsonNode) => {
    if (typeof current.text === 'string') parts.push(current.text);
    if (!Array.isArray(current.content)) return;
    for (const child of current.content as JsonNode[]) {
      // A nested task list holds sub-tasks with their own TODOs.
      if (child.type === 'taskList') continue;
      walk(child);
    }
  };
  walk(node);
  return parts.join('').trim();
}

/** Every task item in document order, nested sub-tasks included. */
export function noteTaskItems(bodyJson: string | null | undefined): NoteTaskItem[] {
  if (!bodyJson) return [];
  let root: unknown;
  try {
    root = JSON.parse(bodyJson);
  } catch {
    return [];
  }
  const items: NoteTaskItem[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as JsonNode;
    if (record.type === 'taskItem') {
      items.push({
        blockId: typeof record.attrs?.id === 'string' ? record.attrs.id : null,
        todoId: typeof record.attrs?.todoId === 'string' ? record.attrs.todoId : null,
        checked: record.attrs?.checked === true,
        text: ownText(record),
      });
    }
    if (Array.isArray(record.content)) record.content.forEach(walk);
  };
  walk(root);
  return items;
}
