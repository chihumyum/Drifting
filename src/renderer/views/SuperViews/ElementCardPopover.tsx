import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useTranslation } from 'react-i18next';
import type { BookElement } from '../../domain/book-element';
import { useBookElement } from '../../usecase/useBookElement';
import { useEntityEditor, type EditorPersistDerived } from '../../hooks/useEntityEditor';
import { useEntityYjsDoc } from '../../hooks/useEntityYjsDoc';
import { useAutosizeTextArea } from '../../hooks/useAutosizeTextArea';
import loglevel from 'loglevel';

const log = loglevel.getLogger('ElementCardPopover');
log.setLevel(loglevel.levels.WARN);

// Mirrors the StoryGraphView NodeCardPopover two-tier UX:
//   · default mode — small anchored card with name + summary quick-edit;
//     two CTAs ("展开编辑" upgrades, "在编辑器中打开" navigates).
//   · upgrade mode — centered modal with name + summary + TipTap editor
//     bound to the same process-wide Y.Doc as the full element editor.
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

interface ElementPopoverBodyEditorProps {
  element: BookElement;
  projectId: string;
  onPersist: (contentJson: string) => void;
}

/**
 * Mount the rich-text hooks only while the expanded body is visible. The
 * process-level Yjs session registry makes this reuse the full editor's live
 * Y.Doc when it is already open; otherwise it performs the same guarded load.
 * A failed replay intentionally falls back to a read-only legacy projection,
 * so corrupt/partial state can never be overwritten from this transient UI.
 */
function ElementPopoverBodyEditor({
  element,
  projectId,
  onPersist,
}: ElementPopoverBodyEditorProps) {
  const { t } = useTranslation();
  const { ydoc, ydocReady, ydocError } = useEntityYjsDoc({
    kind: 'element',
    entityId: element.id,
    projectId,
    legacyContent: element.contentJson ?? null,
  });

  const handlePersist = useCallback(
    (_editor: Editor, { pmJson }: EditorPersistDerived) => onPersist(pmJson),
    [onPersist],
  );

  const { editor } = useEntityEditor({
    sourceKind: 'element',
    sourceId: element.id,
    projectId,
    content: element.contentJson ?? null,
    ydoc,
    onPersist: handlePersist,
    editable: Boolean(ydoc) && !ydocError,
    autoFocus: false,
    placeholder: t('elementEditor.bodyPlaceholder'),
    minHeight: '320px',
  });

  if (ydocError) {
    return (
      <>
        <div
          role="alert"
          style={{
            margin: '0 0 12px',
            padding: '9px 10px',
            border: '1px solid hsl(var(--destructive) / 0.3)',
            borderRadius: 4,
            background: 'hsl(var(--destructive) / 0.08)',
            color: 'hsl(var(--destructive))',
            fontFamily: 'var(--font-serif)',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {t('elementCardPopover.bodyLoadError')}
        </div>
        {editor && (
          <div aria-readonly="true">
            <EditorContent editor={editor} />
          </div>
        )}
      </>
    );
  }

  if (!ydocReady || !ydoc || !editor) {
    return (
      <div
        role="status"
        style={{
          fontFamily: 'var(--font-serif)',
          fontStyle: 'italic',
          color: 'hsl(var(--ink-3))',
          padding: 16,
        }}
      >
        {t('nodeCardPopover.loading')}
      </div>
    );
  }

  return <EditorContent editor={editor} />;
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
  const { t } = useTranslation();
  const [mode, setMode] = useState<'default' | 'upgrade'>('default');
  const [nameDraft, setNameDraft] = useState(element.name);
  const [summaryDraft, setSummaryDraft] = useState(element.summary ?? '');
  const summaryRef = useAutosizeTextArea(summaryDraft);
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

  // The actual editor lives in a child mounted only in upgrade mode. Its Yjs
  // hook resolves to the process-wide shared document instead of treating the
  // potentially-stale contentJson projection as an independent write source.
  const handlePersist = useCallback(
    (next: string) => {
      if (activeElementIdRef.current !== element.id) return;
      if (next === element.contentJson) return;
      void updateElement(element.id, { contentJson: next }).catch((err) => {
        log.error('Failed to persist element content', err);
      });
    },
    [element.id, element.contentJson, updateElement],
  );

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
    if (spaceAbove >= estimatedHeight + POPOVER_GAP || spaceAbove >= spaceBelow) {
      return {
        position: 'fixed',
        width: POPOVER_WIDTH,
        left,
        bottom: vh - anchorRect.top + POPOVER_GAP,
        maxHeight: Math.max(0, spaceAbove - POPOVER_GAP - 8),
      };
    }
    const top = anchorRect.top + anchorRect.height + POPOVER_GAP;
    return {
      position: 'fixed',
      width: POPOVER_WIDTH,
      left,
      top,
      maxHeight: Math.max(0, vh - top - 8),
    };
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
        aria-label={t('elementCardPopover.aria.card')}
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
            placeholder={t('common.untitled')}
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
            title={t('common.close')}
            aria-label={t('common.close')}
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
              ref={summaryRef}
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
              placeholder={t('nodeCardPopover.summaryPlaceholder')}
              rows={1}
              style={{
                width: '100%',
                resize: 'none',
                overflowY: 'auto',
                border: 'none',
                outline: 'none',
                padding: 12,
                background: 'transparent',
                fontFamily: 'var(--font-serif)',
                fontSize: 'calc(var(--entity-body-font-size, 16px) - 4px)',
                lineHeight: 1.5,
                color: 'hsl(var(--ink-1))',
                minHeight: 120,
                maxHeight: 'min(42vh, 320px)',
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
                title={t('nodeCardPopover.expandTitle')}
                style={popoverBtnStyle}
              >
                {t('nodeCardPopover.expand')} ↗
              </button>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => onOpenInEditor(element.id)}
                title={t('nodeCardPopover.openFullTitle')}
                style={{ ...popoverBtnStyle, ...popoverPrimaryBtnStyle }}
              >
                {t('nodeCardPopover.openInEditor')} →
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
                ref={summaryRef}
                value={summaryDraft}
                onChange={(e) => setSummaryDraft(e.target.value)}
                onBlur={() => void commitSummary()}
                placeholder={t('elementCardPopover.summaryShortPlaceholder')}
                rows={1}
                style={{
                  width: '100%',
                  resize: 'none',
                  overflowY: 'auto',
                  border: 'none',
                  outline: 'none',
                  padding: '6px 0',
                  background: 'transparent',
                  fontFamily: 'var(--font-serif)',
                  fontSize: 'calc(var(--entity-body-font-size, 16px) - 4px)',
                  fontStyle: 'italic',
                  lineHeight: 1.4,
                  color: 'hsl(var(--ink-3))',
                  borderBottom: '1px dashed hsl(var(--rule))',
                  maxHeight: 140,
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
              <ElementPopoverBodyEditor
                key={element.id}
                element={element}
                projectId={projectId}
                onPersist={handlePersist}
              />
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
                title={t('nodeCardPopover.collapseTitle')}
                style={popoverBtnStyle}
              >
                ↙ {t('nodeCardPopover.collapse')}
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
                {t('elementCardPopover.syncNote')}
              </span>
              <button
                type="button"
                onClick={() => onOpenInEditor(element.id)}
                title={t('nodeCardPopover.openFullTitle')}
                style={{ ...popoverBtnStyle, ...popoverPrimaryBtnStyle }}
              >
                {t('nodeCardPopover.fullEditor')} →
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
