import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface MobilePaperSearchMatch {
  from: number;
  to: number;
}

export interface MobilePaperSearchSnapshot {
  status: 'idle' | 'searching' | 'ready';
  query: string;
  currentIndex: number;
  total: number;
}

export interface MobilePaperSearchOwner {
  readonly id: string;
  getSnapshot: () => MobilePaperSearchSnapshot;
  subscribe: (listener: () => void) => () => void;
  setQuery: (query: string) => void;
  previous: () => void;
  next: () => void;
  clear: () => void;
  destroy?: () => void;
}

const EMPTY_SNAPSHOT: MobilePaperSearchSnapshot = {
  status: 'idle',
  query: '',
  currentIndex: 0,
  total: 0,
};

let registeredOwner: MobilePaperSearchOwner | null = null;
const registryListeners = new Set<() => void>();

export function getMobilePaperSearchOwner(): MobilePaperSearchOwner | null {
  return registeredOwner;
}

export function subscribeMobilePaperSearchOwner(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

export function registerMobilePaperSearchOwner(owner: MobilePaperSearchOwner): () => void {
  registeredOwner?.clear();
  registeredOwner = owner;
  registryListeners.forEach((listener) => listener());
  return () => {
    if (registeredOwner !== owner) return;
    owner.clear();
    registeredOwner = null;
    registryListeners.forEach((listener) => listener());
  };
}

export function collectMobilePaperSearchMatches(
  textRuns: ReadonlyArray<{ text: string; position: number }>,
  query: string,
): MobilePaperSearchMatch[] {
  const normalized = query.toLowerCase();
  if (!normalized) return [];
  const matches: MobilePaperSearchMatch[] = [];
  for (const run of textRuns) {
    const lowered = run.text.toLowerCase();
    let from = 0;
    while (from <= lowered.length - normalized.length) {
      const found = lowered.indexOf(normalized, from);
      if (found < 0) break;
      matches.push({
        from: run.position + found,
        to: run.position + found + query.length,
      });
      from = found + Math.max(1, normalized.length);
    }
  }
  return matches;
}

const highlightKey = new PluginKey<DecorationSet>('mobile-paper-search-highlight');

function createHighlightPlugin() {
  return new Plugin<DecorationSet>({
    key: highlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, old) {
        const spec = transaction.getMeta(highlightKey) as
          | { matches: MobilePaperSearchMatch[]; currentIndex: number }
          | undefined;
        if (spec) {
          return DecorationSet.create(
            transaction.doc,
            spec.matches.map((match, index) =>
              Decoration.inline(match.from, match.to, {
                class:
                  index === spec.currentIndex
                    ? 'find-match find-match-current'
                    : 'find-match',
              }),
            ),
          );
        }
        return transaction.docChanged ? old.map(transaction.mapping, transaction.doc) : old;
      },
    },
    props: {
      decorations(state) {
        return highlightKey.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

function textRunsFromEditor(editor: Editor): Array<{ text: string; position: number }> {
  const runs: Array<{ text: string; position: number }> = [];
  editor.state.doc.descendants((node, position) => {
    if (node.isText && node.text) runs.push({ text: node.text, position });
  });
  return runs;
}

function paint(editor: Editor, matches: MobilePaperSearchMatch[], currentIndex: number): void {
  if (editor.isDestroyed) return;
  const transaction = editor.state.tr.setMeta(highlightKey, { matches, currentIndex });
  editor.view.dispatch(transaction);
}

export function mobilePaperSearchScrollTop(input: {
  scrollTop: number;
  viewportTop: number;
  viewportHeight: number;
  targetTop: number;
  targetHeight: number;
}): number {
  return Math.max(
    0,
    input.scrollTop +
      input.targetTop -
      input.viewportTop -
      (input.viewportHeight - input.targetHeight) / 2,
  );
}

export function createMobileEditorSearchOwner(
  editor: Editor,
  id: string,
): MobilePaperSearchOwner {
  let snapshot = EMPTY_SNAPSHOT;
  let matches: MobilePaperSearchMatch[] = [];
  const listeners = new Set<() => void>();
  editor.registerPlugin(createHighlightPlugin());

  const publish = (next: MobilePaperSearchSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const jump = (nextIndex: number) => {
    if (matches.length === 0 || editor.isDestroyed) return;
    const currentIndex = ((nextIndex % matches.length) + matches.length) % matches.length;
    const match = matches[currentIndex];
    try {
      const at = editor.view.domAtPos(match.from);
      const element =
        at.node.nodeType === Node.ELEMENT_NODE
          ? (at.node as HTMLElement)
          : at.node.parentElement;
      const scroller = element?.closest<HTMLElement>('.editor-scroll');
      if (element && scroller) {
        const viewport = scroller.getBoundingClientRect();
        const target = element.getBoundingClientRect();
        scroller.scrollTo({
          top: mobilePaperSearchScrollTop({
            scrollTop: scroller.scrollTop,
            viewportTop: viewport.top,
            viewportHeight: scroller.clientHeight,
            targetTop: target.top,
            targetHeight: target.height,
          }),
          behavior: 'smooth',
        });
      }
    } catch {
      // A concurrent CRDT transaction may invalidate a just-collected position.
    }
    paint(editor, matches, currentIndex);
    publish({ ...snapshot, status: 'ready', currentIndex, total: matches.length });
  };
  const recompute = (query: string, preserveIndex = false) => {
    matches = collectMobilePaperSearchMatches(textRunsFromEditor(editor), query);
    const hinted = preserveIndex
      ? Math.min(snapshot.currentIndex, Math.max(0, matches.length - 1))
      : Math.max(
          0,
          matches.findIndex((match) => match.from >= editor.state.selection.from),
        );
    const currentIndex = matches.length === 0 ? 0 : hinted;
    paint(editor, matches, currentIndex);
    publish({ status: query ? 'ready' : 'idle', query, currentIndex, total: matches.length });
  };
  const onTransaction = () => {
    if (snapshot.query) recompute(snapshot.query, true);
  };
  editor.on('update', onTransaction);

  return {
    id,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setQuery(query) {
      recompute(query);
    },
    previous() {
      jump(snapshot.currentIndex - 1);
    },
    next() {
      jump(snapshot.currentIndex + 1);
    },
    clear() {
      matches = [];
      paint(editor, [], 0);
      publish(EMPTY_SNAPSHOT);
    },
    destroy() {
      editor.off('update', onTransaction);
      if (!editor.isDestroyed) editor.unregisterPlugin(highlightKey);
      listeners.clear();
    },
  };
}

export function emptyMobilePaperSearchSnapshot(): MobilePaperSearchSnapshot {
  return EMPTY_SNAPSHOT;
}
