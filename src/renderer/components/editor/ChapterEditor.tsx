import { useCallback, useEffect, useImperativeHandle, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutosizeTextArea } from '../../hooks/useAutosizeTextArea';
import { EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { OutlineItem } from '../../lib/outline';
import { type EntityLinkRef } from '../../lib/extensions/entity-link';
import {
  useEntityEditor,
  type EditorCommentRequest,
  type EditorPersistDerived,
} from '../../hooks/useEntityEditor';
import { useEntityYjsDoc } from '../../hooks/useEntityYjsDoc';
import { useFieldReview } from '../../hooks/useFieldReview';
import { FieldReview } from './FieldReview';
import loglevel from 'loglevel';
import { countWords } from '@/renderer/lib/word-count';
import { recheckChapterPatchValidity } from '../../usecase/patch-validity';
import { PatchCreateModal } from './PatchCreateModal';
import {
  patchRequestFromComment,
  type PatchCreateRequest,
} from './patch-create-request';
import { CopilotEditorMount } from '../copilot/CopilotEditorMount';
import { CopilotInlinePopover } from '../copilot/CopilotInlinePopover';
const log = loglevel.getLogger('ChapterEditor');
log.setLevel(log.levels.WARN);
// log.setLevel(loglevel.levels.DEBUG);

// editor component with built-in element tracking and outline extraction, and more

interface ChapterEditorProps {
  nodeId: string;
  content: string | null; // legacy pm_json string (migration seed only)
  title?: string;
  summary?: string;
  projectId: string;
  ref?: Ref<ChapterEditorRef>;

  // 内容更新回调 — wordCount is the materialized count derived from the
  // editor's plain text via the shared `countWords` algorithm.
  onContentUpdate: (
    nodeId: string,
    pmJson: string,
    outlineJson: string,
    wordCount: number,
  ) => void;
  onTitleUpdate?: (nodeId: string, title: string) => void;
  onSummaryUpdate?: (nodeId: string, summary: string) => void;
  onEntityClick?: (ref: EntityLinkRef) => void;
  // Live outline of the chapter's headings (h1/h2/h3). Fires on load and
  // after every edit. Used by NodeEditorView to render the left TOC rail.
  onOutlineChange?: (outline: OutlineItem[]) => void;
  onAddCommentRequest?: (request: EditorCommentRequest) => void;

  // 显示选项
  showTitle?: boolean;
  showSummary?: boolean;

  // 编辑选项
  editableTitle?: boolean;
  editableSummary?: boolean;
  // Read-only prose body (chapter locked during shadow review).
  readOnly?: boolean;

  // 样式选项
  autoFocus?: boolean;
  minHeight?: string;
  compact?: boolean; // 紧凑模式，用于多章节显示
  selectionKey?: string | null;
  // When set, the editor places the caret at these viewport coords once it has
  // mounted — used when a click promotes a static all-chapters row to this live
  // editor, so the cursor lands where the user pressed rather than at the doc
  // edge. Cleared (null) the rest of the time.
  activateCaret?: { clientX: number; clientY: number } | null;
}

export interface ChapterEditorRef {
  editor: Editor | null;
  focusEditor: () => void;
}

export function ChapterEditor({
  nodeId,
  content,
  title = '',
  summary = '',
  projectId,
  ref: forwardedRef,
  onContentUpdate,
  onTitleUpdate,
  onSummaryUpdate,
  onEntityClick,
  onOutlineChange,
  onAddCommentRequest,
  showTitle = false,
  showSummary = false,
  editableTitle = false,
  editableSummary = false,
  readOnly = false,
  autoFocus = false,
  minHeight = '300px',
  compact = false,
  selectionKey,
  activateCaret = null,
}: ChapterEditorProps) {
  const { t } = useTranslation();
  if (!projectId) {
    throw new Error('ChapterEditor requires projectId');
  }

  const [titleValue, setTitleValue] = useState(title);
  const [summaryValue, setSummaryValue] = useState(summary);
  // Reset local title/summary state when the parent's nodeId or props change,
  // using the prev-snapshot pattern to avoid the setState-in-effect anti-pattern.
  const [syncedKey, setSyncedKey] = useState({ nodeId, title, summary });
  if (
    syncedKey.nodeId !== nodeId ||
    syncedKey.title !== title ||
    syncedKey.summary !== summary
  ) {
    setSyncedKey({ nodeId, title, summary });
    setTitleValue(title);
    setSummaryValue(summary);
  }

  // New-patch pipeline: triggered from the text-selection context menu
  // ("新建补丁"). Carries the selection's chapter/block anchor + precise text
  // anchor so the created patch can be invalidated when that text is deleted.
  const [patchRequest, setPatchRequest] = useState<PatchCreateRequest | null>(null);
  const handleAddPatchRequest = useCallback((request: EditorCommentRequest) => {
    setPatchRequest(patchRequestFromComment(request));
  }, []);

  // Yjs binding — all Yjs concerns (docId, seed, sync, snapshot) live in
  // useEntityYjsDoc. Editor views don't talk to useYjsSync directly.
  const { ydoc } = useEntityYjsDoc({
    kind: 'node-content',
    entityId: nodeId,
    projectId,
    legacyContent: content,
  });

  // Development-only escape hatch for CRDT inspection. Never retain a live
  // manuscript document on the production window object, and clean up the
  // reference when this editor unmounts or switches documents.
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    const devWindow = window as Window & { __ydoc?: typeof ydoc };
    devWindow.__ydoc = ydoc;
    return () => {
      if (devWindow.__ydoc === ydoc) delete devWindow.__ydoc;
    };
  }, [ydoc]);

  // Persist chapter content. pmJson + outline come pre-derived from
  // useEntityEditor; chapter only adds wordCount, which is its only
  // entity-specific materialized field.
  const handlePersist = useCallback(
    (ed: Editor, { pmJson, outlineJson }: EditorPersistDerived) => {
      const wordCount = countWords(ed.getText());
      onContentUpdate(nodeId, pmJson, outlineJson, wordCount);
      // Re-evaluate text-anchored patches sourced from this chapter against the
      // freshly-serialized doc: if the author just deleted the text a patch was
      // anchored to, the patch is invalidated (and dropped from Shadow/canon).
      void recheckChapterPatchValidity(projectId, nodeId, pmJson);
    },
    [nodeId, projectId, onContentUpdate],
  );

  const { editor, outline } = useEntityEditor({
    sourceKind: 'node',
    sourceId: nodeId,
    projectId,
    content,
    ydoc,
    onPersist: handlePersist,
    onEntityClick,
    autoFocus,
    minHeight,
    typewriterScrolling: true,
    selectionKey,
    onAddCommentRequest,
    onAddPatchRequest: handleAddPatchRequest,
    enableInlineCopilot: true,
    // Never allow a fallback non-Yjs editor while the shared document is
    // loading or has failed replay: those edits would have no durable owner.
    editable: Boolean(ydoc) && !readOnly,
  });

  // Forward the live outline up to NodeEditorView so it can render the TOC.
  useEffect(() => {
    onOutlineChange?.(outline);
  }, [outline, onOutlineChange]);

  // Place the caret where the user clicked when this row was promoted from
  // static prose to a live editor. Wait two frames so the editor has mounted and
  // its Yjs-seeded content has laid out before mapping the click coords to a doc
  // position; fall back to a plain focus if the point misses (e.g. clicked the
  // page margin).
  useEffect(() => {
    if (!editor || !activateCaret) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        const found = editor.view.posAtCoords({
          left: activateCaret.clientX,
          top: activateCaret.clientY,
        });
        if (found) {
          editor.chain().setTextSelection(found.pos).focus().run();
        } else {
          editor.commands.focus();
        }
      });
    });
    return () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [editor, activateCaret]);

  // Expose editor + focus helper to the parent (NodeEditorView's ref).
  useImperativeHandle(
    forwardedRef,
    () => ({
      editor,
      focusEditor: () => {
        editor?.commands.focus('end');
      },
    }),
    [editor],
  );

  const handleTitleSave = () => {
    const nextTitle = titleValue.trim();
    if (!nextTitle) {
      setTitleValue(title);
      return;
    }
    if (onTitleUpdate && nextTitle !== title) {
      onTitleUpdate(nodeId, nextTitle);
    }
  };

  const handleSummarySave = () => {
    const nextSummary = summaryValue.trim();
    if (onSummaryUpdate && nextSummary !== summary) {
      onSummaryUpdate(nodeId, nextSummary);
    }
  };

  // 概要 textarea 自动增高，去掉固定 rows 的裁切
  const summaryRef = useAutosizeTextArea(summaryValue);

  // Agent summary edits surface for review here (the prop re-syncs summaryValue on
  // accept/reject, so the textarea always reflects the store).
  const nodeFieldReview = useFieldReview(
    'node',
    nodeId,
    projectId,
    {},
    { summary: (v) => onSummaryUpdate?.(nodeId, v) },
  );
  const nodeSummaryChange = nodeFieldReview.summaryChange;

  if (!editor) {
    log.error('Editor not initialized');
    return null;
  }

  const literary = !compact;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {/* Title and Summary Header */}
      {(showTitle || showSummary) && (
        <div
          style={{
            display: literary ? 'block' : 'flex',
            justifyContent: literary ? undefined : 'space-between',
            alignItems: literary ? undefined : 'flex-start',
            gap: literary ? 0 : '12px',
            marginBottom: literary ? 0 : '12px',
            padding: literary ? 0 : '16px 24px',
            borderBottom: literary ? 'none' : '1px solid rgba(184, 153, 104, 0.15)',
          }}
        >
          {/* Title */}
          {showTitle && (
            <div style={{ flex: literary ? undefined : 1 }}>
              {editableTitle ? (
                <input
                  type="text"
                  value={titleValue}
                  placeholder={t('chapterEditor.untitledChapter')}
                  onChange={(e) => setTitleValue(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                      setTimeout(() => editor?.commands.focus('start'), 50);
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      editor?.commands.focus('start');
                    } else if (e.key === 'Escape') {
                      setTitleValue(title);
                      e.currentTarget.blur();
                    }
                  }}
                  onFocus={(e) => e.target.select()}
                  className={literary ? 'page__title' : undefined}
                  style={
                    literary
                      ? undefined
                      : {
                          width: '100%',
                          fontSize: 20,
                          fontWeight: 700,
                          background: 'transparent',
                          outline: 'none',
                        }
                  }
                />
              ) : literary ? (
                <h1 className="page__title" style={{ margin: '0 0 10px' }}>
                  {titleValue || 'Untitled Chapter'}
                </h1>
              ) : (
                <div style={{ fontSize: 20, fontWeight: 600, background: 'transparent' }}>
                  {titleValue || 'Untitled Chapter'}
                </div>
              )}
            </div>
          )}

          {/* Summary */}
          {showSummary && (
            <div data-agent-summary style={{ flex: literary ? undefined : 1 }}>
              {nodeSummaryChange ? (
                <FieldReview
                  change={nodeSummaryChange}
                  onAccept={() => nodeFieldReview.accept(nodeSummaryChange)}
                  onReject={() => nodeFieldReview.reject(nodeSummaryChange)}
                />
              ) : editableSummary ? (
                <textarea
                  ref={summaryRef}
                  value={summaryValue}
                  placeholder={literary ? 'A subtitle, or an epigraph…' : 'Click to add summary...'}
                  onChange={(e) => setSummaryValue(e.target.value)}
                  onBlur={handleSummarySave}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSummaryValue(summary);
                      e.currentTarget.blur();
                    }
                  }}
                  rows={1}
                  className={literary ? 'page__sub' : undefined}
                  style={
                    literary
                      ? undefined
                      : {
                          width: '100%',
                          // 概要比正文小两号，跟随用户字号设置
                          fontSize: 'calc(var(--editor-font-size, 17.5px) - 2px)',
                          fontWeight: 400,
                          background: 'transparent',
                          color: '#5a4a3a',
                          resize: 'none',
                          overflow: 'hidden',
                          outline: 'none',
                        }
                  }
                />
              ) : literary ? (
                summaryValue ? (
                  <p className="page__sub" style={{ marginBottom: 28 }}>
                    {summaryValue}
                  </p>
                ) : null
              ) : (
                <div style={{ fontSize: 14, fontWeight: 400, background: 'transparent' }}>
                  {summaryValue || (editableSummary ? 'Click to add summary...' : '')}
                </div>
              )}
            </div>
          )}


          {literary && <hr className="page__rule" />}
        </div>
      )}

      {/* Editor Content */}
      <div className={literary ? 'page__body' : undefined} style={{ padding: compact ? '16px 24px' : '0' }}>
        <EditorContent editor={editor} />
      </div>

      <PatchCreateModal
        projectId={projectId}
        request={patchRequest}
        onClose={() => setPatchRequest(null)}
      />

      {/* Headless mount — runs Copilot capabilities (element-candidate, element-patch) on debounced edits */}
      <CopilotEditorMount editor={editor} projectId={projectId} nodeId={nodeId} />

      {/* Cmd+Shift+I inline-Copilot popover (input box + capability menu). Renders
          only when its nodeId matches the active invocation. */}
      <CopilotInlinePopover editor={editor} nodeId={nodeId} />
    </div>
  );
}
