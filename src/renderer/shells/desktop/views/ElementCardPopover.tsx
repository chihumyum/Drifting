import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useTranslation } from 'react-i18next';
import type { BookElement } from '../../../domain/book-element';
import { useBookElement } from '../../../usecase/useBookElement';
import { useEntityEditor, type EditorPersistDerived } from '../../../hooks/useEntityEditor';
import { useEntityYjsDoc } from '../../../hooks/useEntityYjsDoc';
import { useAutosizeTextArea } from '../../../hooks/useAutosizeTextArea';
import {
  EntityCardPopoverShell,
  type EntityCardAnchorRect,
} from '../../../components/ui/EntityCardPopoverShell';
import { GhostIconButton } from '../../../components/ui/GhostIconButton';
import { X } from 'lucide-react';
import loglevel from 'loglevel';

const log = loglevel.getLogger('ElementCardPopover');
log.setLevel(loglevel.levels.WARN);

// Mirrors the StoryGraphView NodeCardPopover two-tier UX:
//   · default mode — small anchored card with name + summary quick-edit;
//     two CTAs ("展开编辑" upgrades, "在编辑器中打开" navigates).
//   · upgrade mode — centered modal with name + summary + TipTap editor
//     bound to the same process-wide Y.Doc as the full element editor.
// Closes on unhandled ESC and outside click. Inputs and the TipTap editor get
// the first chance to consume ESC for their own transient state; otherwise the
// shared shell dismisses the card even while contenteditable holds focus.

export type AnchorRect = EntityCardAnchorRect;

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
    seedContentJson: element.contentJson ?? null,
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
            fontFamily: 'var(--font-sans)',
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
          fontFamily: 'var(--font-sans)',
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

  const close = useCallback(() => {
    void commitName();
    void commitSummary();
    onClose();
  }, [commitName, commitSummary, onClose]);

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

  return (
    <EntityCardPopoverShell
        mode={mode}
        anchorRect={anchorRect}
        popoverWidth={380}
        estimatedHeight={240}
        onClose={close}
        ariaLabel={t('elementCardPopover.aria.card')}
        className="element-card-popover"
        style={{ borderColor: accentColor }}
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
              fontFamily: 'var(--font-sans)',
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
              fontFamily: 'var(--font-sans)',
              fontSize: 14,
              fontWeight: 500,
              color: 'hsl(var(--ink-1))',
              padding: '2px 0',
            }}
          />
          <GhostIconButton
            onClick={close}
            title={t('common.close')}
            aria-label={t('common.close')}
            size="sm"
            icon={<X size={14} aria-hidden="true" />}
          />
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
                fontFamily: 'var(--font-sans)',
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
                  fontFamily: 'var(--font-sans)',
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
    </EntityCardPopoverShell>
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
