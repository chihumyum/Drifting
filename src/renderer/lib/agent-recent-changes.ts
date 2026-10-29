// What the Agent just wrote into the prose, kept coloured on the desktop until
// the author's pointer rests on it: added words green, rewritten words purple.
// The marks live in memory for this run of the app: they survive switching
// tabs and show in the whole-book reader too, and a mark goes when the author
// points at it, when the words it marks are edited away, or when the Agent
// changes the same block again.
import { diffTokens, type AgentBlockChange } from './agent/block-diff';
import { entityKey, type ActivityEntityType } from './agent/tool-entity-ref';
import { RECENT_CHANGE_FADE_MS } from './motion';

export interface AgentRecentMark {
  id: string;
  /** `entityType:id` of the document the mark belongs to. */
  entity: string;
  entityType: ActivityEntityType;
  blockId: string;
  /** Character offsets in the block's text. */
  start: number;
  end: number;
  text: string;
  kind: 'new' | 'chg';
  /** 0 while it shows; 1 and 2 while its colour eases back to ink. */
  fade: 0 | 1 | 2;
}

/** The places a change left new words, in the new text's offsets: a place
 * that only added is `new`, one that replaced words is `chg`. */
export function agentRecentMarkSpans(change: Pick<AgentBlockChange, 'op' | 'oldText' | 'newText'>) {
  if (change.op === 'deleted' || !change.newText) return [];
  if (change.op === 'new') return [{ start: 0, end: change.newText.length, kind: 'new' as const }];
  const spans: { start: number; end: number; kind: 'new' | 'chg' }[] = [];
  let offset = 0;
  let replaced = false;
  let start = -1;
  const close = () => {
    if (start >= 0 && offset > start) spans.push({ start, end: offset, kind: replaced ? 'chg' : 'new' });
    start = -1;
    replaced = false;
  };
  for (const segment of diffTokens(change.oldText, change.newText)) {
    if (segment.kind === 'equal') { close(); offset += segment.text.length; continue; }
    if (segment.kind === 'del') { replaced = true; continue; }
    if (start < 0) start = offset;
    offset += segment.text.length;
  }
  close();
  return spans.filter((span) => change.newText.slice(span.start, span.end).trim().length > 0);
}

let marks: readonly AgentRecentMark[] = [];
let serial = 0;
const listeners = new Set<() => void>();
const fading = new Map<string, ReturnType<typeof setTimeout>>();

function publish(next: readonly AgentRecentMark[]) {
  marks = next;
  listeners.forEach((listener) => listener());
}

export function getAgentRecentMarks(): readonly AgentRecentMark[] {
  return marks;
}

export function subscribeAgentRecentMarks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Keep what a revealed change wrote coloured (replacing the block's older marks). */
export function recordAgentRecentChange(entityType: ActivityEntityType, id: string, change: AgentBlockChange) {
  if (change.field) return;
  const entity = entityKey(entityType, id);
  const kept = marks.filter((mark) => mark.entity !== entity || mark.blockId !== change.blockId);
  const added = agentRecentMarkSpans(change).map((span) => {
    serial += 1;
    return {
      id: `${entity}:${change.blockId}:${serial}`,
      entity, entityType, blockId: change.blockId,
      start: span.start, end: span.end, text: change.newText.slice(span.start, span.end),
      kind: span.kind, fade: 0 as const,
    };
  });
  if (added.length === 0 && kept.length === marks.length) return;
  publish([...kept, ...added]);
}

/** The author's pointer has rested on a mark: its colour eases back to ink in
 * two steps and the mark goes. */
export function dismissAgentRecentMark(markId: string) {
  if (fading.has(markId) || !marks.some((mark) => mark.id === markId)) return;
  const step = RECENT_CHANGE_FADE_MS / 3;
  const set = (fade: 1 | 2) => publish(marks.map((mark) => (mark.id === markId ? { ...mark, fade } : mark)));
  set(1);
  fading.set(markId, setTimeout(() => {
    set(2);
    fading.set(markId, setTimeout(() => {
      fading.delete(markId);
      forgetAgentRecentMarks([markId]);
    }, step));
  }, step));
}

/** Drop marks whose words are no longer there (edited away). */
export function forgetAgentRecentMarks(markIds: readonly string[]) {
  if (markIds.length === 0) return;
  const gone = new Set(markIds);
  const next = marks.filter((mark) => !gone.has(mark.id));
  if (next.length !== marks.length) publish(next);
}
