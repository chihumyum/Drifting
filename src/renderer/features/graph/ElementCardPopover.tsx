import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { useTranslation } from 'react-i18next';
import type { BookElement } from '../../domain/book-element';
import { useBookElement } from '../../usecase/useBookElement';
import { useEntityEditor, type EditorPersistDerived } from '../../hooks/useEntityEditor';
import { useEntityYjsDoc } from '../../hooks/useEntityYjsDoc';
import { useAutosizeTextArea } from '../../hooks/useAutosizeTextArea';
import {
  EntityCardPopoverShell,
  type EntityCardAnchorRect,
} from '../../components/ui/EntityCardPopoverShell';
import { GhostIconButton } from '../../components/ui/GhostIconButton';
import { EditorDocumentLoadError } from '../../components/editor/EditorDocumentLoadError';
import loglevel from 'loglevel';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { Button } from '../../components/ui/Button';
import { KindMark } from '../../components/ui/KindMark';

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
 * A failed replay stays fail-closed; a legacy projection is never mounted as
 * an editable or visually authoritative replacement for canonical Yjs prose.
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

  const { editor, ready: editorReady } = useEntityEditor({
    sourceKind: 'element',
    sourceId: element.id,
    projectId,
    content: element.contentJson ?? null,
    documentMode: 'yjs',
    ydoc,
    onPersist: handlePersist,
    editable: Boolean(ydoc) && !ydocError,
    autoFocus: false,
    placeholder: t('elementEditor.bodyPlaceholder'),
    minHeight: '320px',
  });

  if (ydocError) {
    return <EditorDocumentLoadError />;
  }

  if (!ydocReady || !ydoc || !editor || !editorReady) {
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

  // The same floating layer as the chapter card — the element's square seal
  // in its category's colour, the name as plain words, the summary in the
  // field's slip, no rules, one primary button.
  const nameInput = (
    <input
      type="text"
      className="entity-card__title-input"
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
    />
  );
  return (
    <EntityCardPopoverShell
      mode={mode}
      anchorRect={anchorRect}
      popoverWidth={380}
      estimatedHeight={240}
      onClose={close}
      ariaLabel={t('elementCardPopover.aria.card')}
      className="element-card-popover entity-card"
    >
      <div className="entity-card__head">
        <KindMark kind="element" color={accentColor} />
        {nameInput}
        {mode === 'upgrade' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode('default')}
            title={t('nodeCardPopover.collapseTitle')}
          >
            <BrushIcon name="arrow-in" size={11} /> {t('nodeCardPopover.collapse')}
          </Button>
        )}
        <GhostIconButton
          onClick={close}
          title={t('common.close')}
          aria-label={t('common.close')}
          size="sm"
          icon={<BrushIcon name="close" size={14} />}
        />
      </div>
      {mode === 'default' ? (
        <label className="entity-card__slip ui-field ui-field--area glass glass--rest glass--field">
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
          />
        </label>
      ) : (
        <div className="entity-card__page">
          <textarea
            ref={summaryRef}
            className="entity-card__summary-line"
            value={summaryDraft}
            onChange={(e) => setSummaryDraft(e.target.value)}
            onBlur={() => void commitSummary()}
            placeholder={t('elementCardPopover.summaryShortPlaceholder')}
            rows={1}
          />
          <ElementPopoverBodyEditor
            key={element.id}
            element={element}
            projectId={projectId}
            onPersist={handlePersist}
          />
        </div>
      )}
      <div className="entity-card__foot">
        {mode === 'default' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void commitName();
              void commitSummary();
              setMode('upgrade');
            }}
            title={t('nodeCardPopover.expandTitle')}
          >
            <BrushIcon name="arrow-out" size={11} /> {t('nodeCardPopover.expand')}
          </Button>
        ) : (
          <span className="entity-card__meta">{t('elementCardPopover.syncNote')}</span>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => onOpenInEditor(element.id)}
          title={t('nodeCardPopover.openFullTitle')}
        >
          {mode === 'default' ? t('nodeCardPopover.openInEditor') : t('nodeCardPopover.fullEditor')}
          <BrushIcon name="arrow-forward" size={11} />
        </Button>
      </div>
    </EntityCardPopoverShell>
  );
}
