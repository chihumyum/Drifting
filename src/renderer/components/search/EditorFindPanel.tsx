import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { FindResultsList, type FindResultRow } from './FindResultsList';
import { FindToolbar } from './FindToolbar';
import '../../../styles/search.css';

interface Match {
  from: number;
  to: number;
}

// Walk the doc and find every (case-insensitive) occurrence of `query` in the
// concatenated text. Returns ProseMirror absolute positions per match.
function collectMatches(editor: Editor, query: string): Match[] {
  if (!query) return [];
  const lowered = query.toLowerCase();
  const matches: Match[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let searchFrom = 0;
    while (searchFrom <= text.length - lowered.length) {
      const found = text.indexOf(lowered, searchFrom);
      if (found < 0) break;
      matches.push({ from: pos + found, to: pos + found + query.length });
      searchFrom = found + Math.max(1, query.length);
    }
  });
  return matches;
}

// PM plugin that paints all matches as background-coloured decorations and
// emphasises the current one. We need this because pressing Enter inside the
// find input keeps focus on the input — the editor itself is not focused, so
// PM's native selection rendering is invisible. Decorations paint regardless
// of focus.
interface HighlightSpec {
  matches: Match[];
  currentIndex: number;
}

const findHighlightKey = new PluginKey<DecorationSet>('editor-find-highlight');

function buildDecorations(doc: ProseMirrorNode, spec: HighlightSpec): DecorationSet {
  if (spec.matches.length === 0) return DecorationSet.empty;
  const decos = spec.matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === spec.currentIndex ? 'find-match find-match-current' : 'find-match',
    }),
  );
  return DecorationSet.create(doc, decos);
}

function createHighlightPlugin() {
  return new Plugin<DecorationSet>({
    key: findHighlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old) {
        const meta = tr.getMeta(findHighlightKey) as HighlightSpec | undefined;
        if (meta) return buildDecorations(tr.doc, meta);
        return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
      },
    },
    props: {
      decorations(state) {
        return findHighlightKey.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

interface EditorFindPanelProps {
  editor: Editor;
  onClose: () => void;
}

export function EditorFindPanel({ editor, onClose }: EditorFindPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Register the highlight plugin on mount, tear down on unmount. Using
  // editor.registerPlugin / unregisterPlugin keeps this scoped to the find
  // panel's lifetime — no need to wire the extension into every editor setup
  // site.
  useEffect(() => {
    const plugin = createHighlightPlugin();
    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(findHighlightKey);
    };
  }, [editor]);

  // Focus the input on mount and pre-fill from current selection if any.
  useEffect(() => {
    const { from, to } = editor.state.selection;
    if (from !== to) {
      const selected = editor.state.doc.textBetween(from, to, ' ').trim();
      if (selected) setQuery(selected);
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editor]);

  // Recompute matches whenever the query or doc changes.
  const matches = useMemo(() => collectMatches(editor, query), [editor, query]);

  // One-line context snippet per match for the results list. Pulled straight
  // from the doc around each hit (a single editor → a flat, ungrouped list).
  const resultRows = useMemo<FindResultRow[]>(() => {
    if (!query) return [];
    const doc = editor.state.doc;
    const size = doc.content.size;
    // Asymmetric: little leading context so the hit stays left-of-clip + visible,
    // plenty of trailing context to fill the row (rows clip on the right only).
    const padBefore = 10;
    const padAfter = 60;
    return matches.map((m, i) => {
      const ctxFrom = Math.max(0, m.from - padBefore);
      const ctxTo = Math.min(size, m.to + padAfter);
      const before = doc.textBetween(ctxFrom, m.from, ' ', ' ');
      const hit = doc.textBetween(m.from, m.to, ' ', ' ');
      const after = doc.textBetween(m.to, ctxTo, ' ', ' ');
      const prefix = ctxFrom > 0 ? '…' : '';
      const matchStart = prefix.length + before.length;
      return {
        index: i,
        groupKey: 'doc',
        groupLabel: '',
        excerpt: prefix + before + hit + after + (ctxTo < size ? '…' : ''),
        matchStart,
        matchEnd: matchStart + hit.length,
      };
    });
  }, [editor, matches, query]);

  // Push current matches + index into the plugin so decorations repaint.
  useEffect(() => {
    const { tr } = editor.state;
    tr.setMeta(findHighlightKey, { matches, currentIndex });
    editor.view.dispatch(tr);
  }, [editor, matches, currentIndex]);

  // Scroll the DOM element under a given PM position into view. We don't rely
  // on tiptap's .scrollIntoView() because PM's scrollPosIntoView can pick the
  // wrong scroll ancestor when the editor lives inside multiple nested
  // overflow containers (which is the case here — the editor sits inside a
  // panel that sits inside a tab body). Native scrollIntoView walks up the
  // overflow chain reliably.
  const scrollMatchIntoView = useCallback(
    (from: number) => {
      try {
        const at = editor.view.domAtPos(from);
        const el =
          at.node.nodeType === Node.ELEMENT_NODE ? (at.node as HTMLElement) : at.node.parentElement;
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {
        // domAtPos can throw if the doc was mutated between query and jump.
      }
    },
    [editor],
  );

  const jumpTo = useCallback(
    (index: number) => {
      if (matches.length === 0) return;
      const wrapped = ((index % matches.length) + matches.length) % matches.length;
      const match = matches[wrapped];
      setCurrentIndex(wrapped);
      editor.chain().setTextSelection({ from: match.from, to: match.to }).run();
      scrollMatchIntoView(match.from);
    },
    [editor, matches, scrollMatchIntoView],
  );

  // Jump to first match on query change.
  useEffect(() => {
    if (matches.length === 0) {
      setCurrentIndex(0);
      return;
    }
    // Use the current editor selection as a hint: pick the first match at or
    // after the cursor; otherwise wrap to 0.
    const caret = editor.state.selection.from;
    const next = matches.findIndex((m) => m.from >= caret);
    const target = next === -1 ? 0 : next;
    setCurrentIndex(target);
    const m = matches[target];
    editor.chain().setTextSelection({ from: m.from, to: m.to }).run();
    scrollMatchIntoView(m.from);
    // Intentionally not depending on editor.state.selection — we only want to
    // re-jump when the query/matches change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      jumpTo(e.shiftKey ? currentIndex - 1 : currentIndex + 1);
    }
  };

  const noMatches = matches.length === 0;

  return (
    <div
      className="editor-find-dock"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <FindToolbar
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('findPanel.currentPlaceholder')}
        stats={noMatches ? '0/0' : `${currentIndex + 1}/${matches.length}`}
        noMatches={noMatches}
        onPrevious={() => jumpTo(currentIndex - 1)}
        onNext={() => jumpTo(currentIndex + 1)}
        onClose={onClose}
        previousTitle={t('findPanel.previousTitle')}
        nextTitle={t('findPanel.nextTitle')}
        closeTitle={t('findPanel.closeTitle')}
      />

      <FindResultsList
        rows={resultRows}
        activeIndex={currentIndex}
        onPick={jumpTo}
        totalCount={matches.length}
      />
    </div>
  );
}
