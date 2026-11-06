import { useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@tiptap/core';
import { BrushIcon, type BrushIconName } from '../../../components/ui/BrushIcon';
import { getBlockFormatItems, getInlineFormatItems, type BlockFormatItem } from '../../../lib/slash-menu/block-format-items';
import { selectionActionsFor } from '../../../features/editor/editor-selection-bar';
import type { MobileKeyboardBar as BarMode } from './mobile-desk-controller';
import { useTodayWords } from '../../../components/workspaceChrome/useTodayWords';

const FORMAT_GLYPHS: Readonly<Record<string, BrushIconName>> = {
  paragraph: 'fmt-paragraph', h1: 'fmt-h1', h2: 'fmt-h2', h3: 'fmt-h3', blockquote: 'fmt-quote',
  bold: 'fmt-bold', italic: 'fmt-italic', underline: 'fmt-underline', strike: 'fmt-strike',
};
const FORMAT_KEYS: Readonly<Record<string, string>> = {
  paragraph: 'paragraph', h1: 'heading1', h2: 'heading2', h3: 'heading3', blockquote: 'blockquote',
  bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strike',
};

interface MobileKeyboardBarProps {
  projectId: string;
  editor: Editor;
  mode: BarMode;
  keyboardInset: number;
  /** Re-read the formats on every editor transaction. */
  revision: number;
  onModeChange: (mode: BarMode) => void;
  onAskAgent: () => void;
  onDone: () => void;
}

/**
 * The bar on the keyboard's top edge while the author writes (docs/design-system/touch.md):
 * one glass long pill of round glass buttons, like the paper's toolbar. With
 * a selection it carries the selection's own actions, the same the desktop
 * floats over the selected text (where the phone's own edit menu stands):
 * the formats, a comment, a patch, and handing the passage to the Agent.
 * 「格式」 unfolds the formats as a second pill above it. The last button puts
 * the keyboard away.
 */
export function MobileKeyboardBar({ projectId, editor, mode, keyboardInset, revision, onModeChange, onAskAgent, onDone }: MobileKeyboardBarProps) {
  const { t, i18n } = useTranslation();
  // Today's words beside the keyboard, a dry stroke growing toward the day's goal.
  const { todayWords, progress } = useTodayWords(projectId);
  const blocks = useMemo(() => getBlockFormatItems().filter((item) => FORMAT_GLYPHS[item.id]), []);
  const inlines = useMemo(() => getInlineFormatItems().filter((item) => FORMAT_GLYPHS[item.id]), []);
  // `revision` makes the selection and its formats read again after every change.
  const selection = useMemo(() => (editor.isDestroyed ? null : selectionActionsFor(editor)), [editor, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const composing = editor.view.composing;
  const style = { '--m-keyboard-inset': `${keyboardInset}px` } as CSSProperties;

  const formatButton = (item: BlockFormatItem) => {
    const active = item.isActive?.(editor) ?? false;
    const label = t(`mobileWorkspace.editorAccessory.${FORMAT_KEYS[item.id]}`, { defaultValue: item.title });
    return (
      <button
        key={item.id}
        type="button"
        className="m-kbar__icon glass glass--round"
        aria-pressed={active}
        aria-label={label}
        data-debug-id={`mobile-format-${item.id}`}
        disabled={composing}
        // Pressing a format must not take the caret out of the prose.
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => { if (!editor.view.composing) item.run(editor); }}
      >
        <BrushIcon name={FORMAT_GLYPHS[item.id]} />
      </button>
    );
  };

  return (
    <div className="m-kbar" style={style} data-debug-id="mobile-keyboard-bar" data-mode={mode}>
      {mode === 'format' && (
        <div className="m-kbar__formats glass glass--rest glass--surface" role="toolbar" aria-label={t('mobileWorkspace.editorAccessory.label')}>
          {blocks.map(formatButton)}
          <span className="m-kbar__gap" aria-hidden="true" />
          {inlines.map(formatButton)}
        </div>
      )}
      <div className="m-kbar__row">
        <div className="m-kbar__tray glass glass--rest glass--surface" role="toolbar" aria-label={t('mobileDesk.keyboard.label')}>
          <button
            type="button"
            className="m-kbar__icon glass glass--round"
            aria-expanded={mode === 'format'}
            aria-label={t(mode === 'format' ? 'mobileWorkspace.editorAccessory.collapse' : 'mobileWorkspace.editorAccessory.expand')}
            data-debug-id="mobile-toggle-formatting"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onModeChange(mode === 'format' ? 'tools' : 'format')}
          >
            <BrushIcon name="fmt-paragraph" />
          </button>
          {selection?.onAddComment && (
            <button
              type="button"
              className="m-kbar__icon glass glass--round"
              aria-label={selection.labels.addComment}
              data-debug-id="mobile-selection-comment"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => selection.onAddComment?.()}
            >
              <BrushIcon name="comment-plus" />
            </button>
          )}
          {selection?.onAddPatch && (
            <button
              type="button"
              className="m-kbar__icon glass glass--round"
              aria-label={selection.labels.addPatch}
              data-debug-id="mobile-selection-patch"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => selection.onAddPatch?.()}
            >
              <BrushIcon name="sticky-note" />
            </button>
          )}
          <button
            type="button"
            className="m-kbar__icon glass glass--round"
            aria-label={t(selection ? 'mobileDesk.keyboard.askAgentSelection' : 'mobileDesk.keyboard.askAgent')}
            data-debug-id="mobile-keyboard-agent"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onAskAgent}
          >
            <BrushIcon name="shikigami" />
          </button>
        </div>
        {todayWords != null && (
          <span className="m-kbar__today" data-debug-id="mobile-keyboard-today">
            <span className="m-kbar__today-figure">+{todayWords.toLocaleString(i18n.language)}</span>
            {progress != null && <span className="sand-stroke m-kbar__today-goal" style={{ width: `${progress * 100}%` }} />}
          </span>
        )}
        <button
          type="button"
          className="m-kbar__done glass glass--rest glass--round"
          aria-label={t('mobileWorkspace.dismissKeyboard')}
          data-debug-id="mobile-keyboard-done"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onDone}
        >
          <BrushIcon name="chevron-down" />
        </button>
      </div>
    </div>
  );
}
