import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import type { Editor } from '@tiptap/core';

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

interface EditorFindPanelProps {
  editor: Editor;
  onClose: () => void;
}

export function EditorFindPanel({ editor, onClose }: EditorFindPanelProps) {
  const [query, setQuery] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const jumpTo = useCallback(
    (index: number) => {
      if (matches.length === 0) return;
      const wrapped = ((index % matches.length) + matches.length) % matches.length;
      const match = matches[wrapped];
      setCurrentIndex(wrapped);
      editor
        .chain()
        .setTextSelection({ from: match.from, to: match.to })
        .scrollIntoView()
        .run();
    },
    [editor, matches],
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
    editor
      .chain()
      .setTextSelection({ from: m.from, to: m.to })
      .scrollIntoView()
      .run();
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

  return (
    <div
      style={{
        position: 'fixed',
        top: 56,
        right: 24,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        background: '#fefdfb',
        border: '1px solid #e8dcc8',
        borderRadius: 8,
        boxShadow: '0 6px 20px rgba(139, 111, 71, 0.18)',
        fontSize: 13,
        color: '#3a2a1a',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="在当前编辑器中查找…"
        style={{
          width: 200,
          padding: '4px 6px',
          border: '1px solid #e8dcc8',
          borderRadius: 4,
          outline: 'none',
          fontSize: 13,
          background: '#fff',
          color: '#3a2a1a',
        }}
      />
      <span style={{ minWidth: 48, textAlign: 'center', color: '#8b7355', fontSize: 12 }}>
        {matches.length === 0 ? '0/0' : `${currentIndex + 1}/${matches.length}`}
      </span>
      <button
        onClick={() => jumpTo(currentIndex - 1)}
        disabled={matches.length === 0}
        title="上一个 (Shift+Enter)"
        style={iconButtonStyle(matches.length === 0)}
      >
        <ChevronUp size={14} />
      </button>
      <button
        onClick={() => jumpTo(currentIndex + 1)}
        disabled={matches.length === 0}
        title="下一个 (Enter)"
        style={iconButtonStyle(matches.length === 0)}
      >
        <ChevronDown size={14} />
      </button>
      <button onClick={onClose} title="关闭 (Esc)" style={iconButtonStyle(false)}>
        <X size={14} />
      </button>
    </div>
  );
}

function iconButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: disabled ? '#c4b59a' : '#5a4a3a',
    cursor: disabled ? 'not-allowed' : 'pointer',
    borderRadius: 4,
  };
}
