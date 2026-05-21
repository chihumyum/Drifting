import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { BookElement } from '../../domain/book-element';
import { useBookElement } from '../../usecase/useBookElement';
import { useEntityEditor } from '../../hooks/useEntityEditor';
import loglevel from 'loglevel';

const log = loglevel.getLogger('ElementCardPopover');
log.setLevel(loglevel.levels.WARN);

// Mirrors the GraphView NodeCardPopover two-tier UX:
//   · default mode — small anchored card with name + summary quick-edit;
//     two CTAs ("展开编辑" upgrades, "在编辑器中打开" navigates).
//   · upgrade mode — centered modal with name + summary + TipTap editor
//     bound through useEntityEditor so element.contentJson stays in sync.
// Closes on ESC and outside click. ESC handler ignores keypresses while
// a form field / contenteditable inside the popover holds focus so the
// inner element can use ESC to revert its own draft.

const POPOVER_WIDTH = 380;
const POPOVER_GAP = 10;
const UPGRADE_WIDTH = 640;
const UPGRADE_HEIGHT_MAX = 720;

export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ElementCardPopoverProps {
  element: BookElement;
  projectId: string;
  userId: string;
  accentColor: string;
  anchorRect: AnchorRect;
  onClose: () => void;
  onOpenInEditor: (elementId: string) => void;
}

export function ElementCardPopover({
  element,
  projectId,
  userId,
  accentColor,
  anchorRect,
  onClose,
  onOpenInEditor,
}: ElementCardPopoverProps) {
  const [mode, setMode] = useState<'default' | 'upgrade'>('default');
  const [nameDraft, setNameDraft] = useState(element.name);
  const [summaryDraft, setSummaryDraft] = useState(element.summary ?? '');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeElementIdRef = useRef(element.id);

  const { updateElement } = useBookElement({ projectId, userId });

  // Reset local drafts when the popover switches to a new element, or the
  // backing row's values change elsewhere. Prev-snapshot pattern avoids
  // setState-in-effect.
  const [syncKey, setSyncKey] = useState({
    id: element.id,
    name: element.name,
    summary: element.summary,
  });
  if (
    syncKey.id !== element.id ||
    syncKey.name !== element.name ||
    syncKey.summary !== element.summary
  ) {
    setSyncKey({ id: element.id, name: element.name, summary: element.summary });
    setNameDraft(element.name);
    setSummaryDraft(element.summary ?? '');
  }

  useEffect(() => {
    activeElementIdRef.current = element.id;
  }, [element.id]);

  // ESC closes — but pass through to focused inputs / the editor so their
  // own revert behavior runs first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const active = document.activeElement as HTMLElement | null;
      const inField =
        !!active &&
        (active.tagName === 'TEXTAREA' ||
          active.tagName === 'INPUT' ||
          active.isContentEditable);
      if (inField && containerRef.current?.contains(active)) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Outside click closes. Defer one tick so the click that opened us
  // doesn't immediately dismiss it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  // --- Save handlers ---
  const commitName = useCallback(async () => {
    const next = nameDraft.trim();
    if (!next || next === element.name) {
      setNameDraft(element.name);
      return;
    }
    try {
      await updateElement(element.id, { name: next });
    } catch (err) {
      log.error('Failed to rename element', err);
    }
  }, [nameDraft, element.id, element.name, updateElement]);

  const commitSummary = useCallback(async () => {
    if (summaryDraft === (element.summary ?? '')) return;
    try {
      await updateElement(element.id, { summary: summaryDraft });
    } catch (err) {
      log.error('Failed to update element summary', err);
    }
  }, [summaryDraft, element.id, element.summary, updateElement]);

  // --- TipTap editor (upgrade mode only) ---
  // Mounted unconditionally so its hooks run on every render — guarded by
  // mode-check inside the persist callback. Lighter than NodeCardPopover's
  // lazy-load pattern because elements keep their contentJson alongside
  // the row (no separate content table to fetch).
  const handlePersist = useCallback(
    (ed: Editor) => {
      if (activeElementIdRef.current !== element.id) return;
      const next = JSON.stringify(ed.getJSON());
      if (next === element.contentJson) return;
      void updateElement(element.id, { contentJson: next }).catch((err) => {
        log.error('Failed to persist element content', err);
      });
    },
    [element.id, element.contentJson, updateElement],
  );

  const { editor } = useEntityEditor({
    sourceKind: 'element',
    sourceId: mode === 'upgrade' ? element.id : '',
    projectId,
    content: element.contentJson ?? null,
    onPersist: handlePersist,
    autoFocus: false,
    placeholder: '记 · 传——写此元素的来历、形貌、心性…',
    minHeight: '320px',
  });

  // --- Positioning ---
  const popoverStyle: React.CSSProperties = (() => {
    if (mode === 'upgrade') {
      const h = Math.min(UPGRADE_HEIGHT_MAX, window.innerHeight - 64);
      return {
        position: 'fixed',
        width: UPGRADE_WIDTH,
        height: h,
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
      };
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const anchorCenterX = anchorRect.left + anchorRect.width / 2;
    let left = anchorCenterX - POPOVER_WIDTH / 2;
    left = Math.max(8, Math.min(left, vw - POPOVER_WIDTH - 8));
    const estimatedHeight = 240;
    const spaceAbove = anchorRect.top;
    const spaceBelow = vh - (anchorRect.top + anchorRect.height);
    let top: number;
    if (spaceAbove >= estimatedHeight + POPOVER_GAP || spaceAbove >= spaceBelow) {
      top = anchorRect.top - estimatedHeight - POPOVER_GAP;
      top = Math.max(8, top);
    } else {
      top = anchorRect.top + anchorRect.height + POPOVER_GAP;
    }
    return { position: 'fixed', width: POPOVER_WIDTH, left, top };
  })();

  return (
    <>
      {mode === 'upgrade' && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'hsl(var(--ink-1) / 0.18)',
            backdropFilter: 'blur(2px)',
            zIndex: 300,
          }}
        />
      )}
      <div
        ref={containerRef}
        role="dialog"
        aria-label="元素卡片"
        style={{
          ...popoverStyle,
          background: 'hsl(var(--paper))',
          border: `1.5px solid ${accentColor}`,
          borderRadius: 4,
          boxShadow: '0 8px 28px hsl(var(--ink-1) / 0.18)',
          zIndex: 301,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Head */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid hsl(var(--rule))',
            background: 'hsl(var(--paper-deep) / 0.5)',
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              color: accentColor,
              fontSize: 12,
              lineHeight: 1,
            }}
          >
            ◆
          </span>
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.currentTarget as HTMLInputElement).blur();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setNameDraft(element.name);
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            placeholder="未命名"
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontFamily: 'var(--font-serif)',
              fontSize: 14,
              fontWeight: 500,
              color: 'hsl(var(--ink-1))',
              padding: '2px 0',
            }}
          />
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'hsl(var(--ink-3))',
              fontSize: 18,
              lineHeight: 1,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        {mode === 'default' ? (
          <>
            <textarea
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              onBlur={() => void commitSummary()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSummaryDraft(element.summary ?? '');
                  (e.currentTarget as HTMLTextAreaElement).blur();
                }
              }}
              placeholder="写一段摘要…"
              rows={6}
              style={{
                width: '100%',
                resize: 'none',
                border: 'none',
                outline: 'none',
                padding: 12,
                background: 'transparent',
                fontFamily: 'var(--font-serif)',
                fontSize: 13,
                lineHeight: 1.5,
                color: 'hsl(var(--ink-1))',
                minHeight: 120,
              }}
            />
            <div
              style={{
                display: 'flex',
                gap: 8,
                padding: '8px 12px',
                borderTop: '1px solid hsl(var(--rule))',
                background: 'hsl(var(--paper-deep) / 0.4)',
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  void commitName();
                  void commitSummary();
                  setMode('upgrade');
                }}
                title="展开为简化编辑器"
                style={popoverBtnStyle}
              >
                展开编辑 ↗
              </button>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => onOpenInEditor(element.id)}
                title="跳转到完整编辑器"
                style={{ ...popoverBtnStyle, ...popoverPrimaryBtnStyle }}
              >
                在编辑器中打开 →
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                padding: '4px 12px 0',
                flexShrink: 0,
              }}
            >
              <textarea
                value={summaryDraft}
                onChange={(e) => setSummaryDraft(e.target.value)}
                onBlur={() => void commitSummary()}
                placeholder="摘要…"
                rows={2}
                style={{
                  width: '100%',
                  resize: 'none',
                  border: 'none',
                  outline: 'none',
                  padding: '6px 0',
                  background: 'transparent',
                  fontFamily: 'var(--font-serif)',
                  fontSize: 12,
                  fontStyle: 'italic',
                  lineHeight: 1.4,
                  color: 'hsl(var(--ink-3))',
                  borderBottom: '1px dashed hsl(var(--rule))',
                }}
              />
            </div>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                padding: '12px 16px',
              }}
            >
              {editor ? (
                <EditorContent editor={editor} />
              ) : (
                <div
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontStyle: 'italic',
                    color: 'hsl(var(--ink-3))',
                    padding: 16,
                  }}
                >
                  载入中…
                </div>
              )}
            </div>
            <div
              style={{
                display: 'flex',
                gap: 8,
                padding: '8px 12px',
                borderTop: '1px solid hsl(var(--rule))',
                background: 'hsl(var(--paper-deep) / 0.4)',
                flexShrink: 0,
                alignItems: 'center',
              }}
            >
              <button
                type="button"
                onClick={() => setMode('default')}
                title="折叠回卡片"
                style={popoverBtnStyle}
              >
                ↙ 折叠
              </button>
              <span
                style={{
                  flex: 1,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9.5,
                  color: 'hsl(var(--ink-4))',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  textAlign: 'center',
                }}
              >
                改动会同步到完整编辑器
              </span>
              <button
                type="button"
                onClick={() => onOpenInEditor(element.id)}
                title="跳转到完整编辑器"
                style={{ ...popoverBtnStyle, ...popoverPrimaryBtnStyle }}
              >
                完整编辑器 →
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

const popoverBtnStyle: React.CSSProperties = {
  border: '1px solid hsl(var(--rule))',
  background: 'hsl(var(--paper))',
  color: 'hsl(var(--ink-2))',
  padding: '4px 10px',
  borderRadius: 3,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  cursor: 'pointer',
};

const popoverPrimaryBtnStyle: React.CSSProperties = {
  borderColor: 'hsl(var(--ink-2))',
  background: 'hsl(var(--ink-1))',
  color: 'hsl(var(--paper))',
};
