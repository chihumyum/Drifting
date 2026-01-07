import { useEffect, useRef, useMemo, useImperativeHandle, useState, useCallback, type Ref } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { createDefaultSlashMenu } from '../../lib/slash-menu';
import { extractOutline, serializeOutline } from '../../lib/outline';
import { ElementAutoLink, elementAutoLinkConfig } from '../../lib/extensions/element-auto-link';
import { ElementParserService } from '../../services/element-parser.service';
import { ElementOccurrenceRepository } from '../../repositories/element-occurrence.repository';
import { useAppStore } from '../../store';
import { TagEditor } from './TagEditor';
import log from 'loglevel';
log.setLevel(log.levels.ERROR);

// editor component with built-in element tracking and outline extraction, and more
const DEFAULT_DOC: JSONContent = { type: 'doc', content: [] };

interface ChapterEditorProps {
  nodeId: string;
  content: string | null; // pm_json string
  title?: string;
  summary?: string;
  ref?: Ref<ChapterEditorRef>;

  // 内容更新回调
  onContentUpdate: (nodeId: string, pmJson: string, outlineJson: string) => void;
  onTitleUpdate?: (nodeId: string, title: string) => void;
  onSummaryUpdate?: (nodeId: string, summary: string | null) => void;
  onElementClick?: (elementId: string) => void;

  // 显示选项
  showTitle?: boolean;
  showSummary?: boolean;
  showTags?: boolean;

  // 编辑选项
  editableTitle?: boolean;
  editableSummary?: boolean;

  // 样式选项
  autoFocus?: boolean;
  minHeight?: string;
  compact?: boolean; // 紧凑模式，用于多章节显示
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
  ref: forwardedRef,
  onContentUpdate,
  onTitleUpdate,
  onSummaryUpdate,
  onElementClick,
  showTitle = false,
  showSummary = false,
  showTags = false,
  editableTitle = false,
  editableSummary = false,
  autoFocus = false,
  minHeight = '300px',
  compact = false,
}: ChapterEditorProps) {
  const { bookElements, autoElementLinkEnabled } = useAppStore();
  const isContentLoadedRef = useRef(false);
  const parseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const loadedNodeIdRef = useRef<string | null>(null);

  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [titleValue, setTitleValue] = useState(title);
  const [summaryValue, setSummaryValue] = useState(summary);

  // 同步外部 title/summary 变化
  useEffect(() => {
    setTitleValue(title);
  }, [title]);

  useEffect(() => {
    setSummaryValue(summary);
  }, [summary]);

  // element tracking
  const elementNamesMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string; category: string }>();
    bookElements.forEach((element) => {
      map.set(element.name, {
        id: element.id,
        name: element.name,
        category: element.category,
      });
    });
    return map;
  }, [bookElements]);

  const parseAndSaveElementOccurrences = useCallback((jsonContent: JSONContent) => {
    if (!autoElementLinkEnabled) return;

    if (parseTimeoutRef.current) {
      clearTimeout(parseTimeoutRef.current);
    }

    parseTimeoutRef.current = setTimeout(async () => {
      try {
        // TODO: maybe there is a performance issue here
        const matches = ElementParserService.parseElementsFromContent(jsonContent, bookElements);
        const repo = new ElementOccurrenceRepository();
        await repo.saveOccurrencesForNode(
          nodeId,
          matches.map((m) => ({
            elementId: m.elementId,
            matches: m.matches,
          }))
        );
      } catch (error) {
        log.error('Failed to parse and save element occurrences:', error);
      }
    }, 1000);
  }, [autoElementLinkEnabled, nodeId, bookElements]);

  // TipTap editor
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
        codeBlock: {},
        underline: false,
        link: false,
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right'],
        defaultAlignment: 'left',
      }),
      ElementAutoLink.configure({
        elementNames: elementNamesMap,
        autoDetectEnabled: autoElementLinkEnabled,
        onClick: onElementClick,
      }),
      createDefaultSlashMenu(),
    ],
    content: DEFAULT_DOC,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none',
        style: `min-height: ${minHeight}`,
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (!isContentLoadedRef.current) {
        log.warn('isContentLoadedRef is false');
        return;
      }

      const json = ed.getJSON();
      const pmJson = JSON.stringify(json);

      // TODO: check if we have a performance issue here
      const outline = extractOutline(pmJson);
      log.debug('Extracted outline:', outline);
      const outlineJson = serializeOutline(outline);
      log.debug('Outline JSON:', outlineJson);
      parseAndSaveElementOccurrences(json);
      log.trace('Updating node', nodeId, 'with content:', pmJson);
      onContentUpdate(nodeId, pmJson, outlineJson);
    },
  });

  // 暴露方法给父组件
  useImperativeHandle(forwardedRef, () => ({
    editor,
    focusEditor: () => {
      editor?.commands.focus('end');
    },
  }), [editor]);

  // 更新元素自动链接配置
  useEffect(() => {
    elementAutoLinkConfig.autoDetectEnabled = autoElementLinkEnabled;
    elementAutoLinkConfig.elementNames = elementNamesMap;
  }, [autoElementLinkEnabled, elementNamesMap]);

  // 加载内容到编辑器
  useEffect(() => {
    if (!editor) return;

    // 阻止在内容加载期间触发 onContentChange
    isContentLoadedRef.current = false;

    try {
      const json = content ? JSON.parse(content) : DEFAULT_DOC;

      // 只有当内容真的不同时才更新（避免不必要的渲染）
      const currentContent = editor.getJSON();
      if (JSON.stringify(currentContent) === JSON.stringify(json)) {
        isContentLoadedRef.current = true;
        loadedNodeIdRef.current = nodeId;
        return;
      }

      editor.commands.setContent(json);

      if (autoFocus && loadedNodeIdRef.current !== nodeId) {
        setTimeout(() => {
          if (editor.view) {
            editor.commands.focus('end');
            editor.commands.setTextSelection(editor.state.doc.content.size);
          }
        }, 0);
      }
    } catch (error) {
      log.error('Failed to parse chapter content', error);
      editor.commands.setContent(DEFAULT_DOC);
    }

    setTimeout(() => {
      isContentLoadedRef.current = true;
      loadedNodeIdRef.current = nodeId;
    }, 0);
  }, [editor, content, nodeId, autoFocus]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (parseTimeoutRef.current) {
        clearTimeout(parseTimeoutRef.current);
      }
    };
  }, []);

  // 处理标题保存
  const handleTitleSave = () => {
    setEditingTitle(false);
    if (onTitleUpdate && titleValue.trim() && titleValue !== title) {
      onTitleUpdate(nodeId, titleValue.trim());
    }
  };

  // 处理摘要保存
  const handleSummarySave = () => {
    setEditingSummary(false);
    if (onSummaryUpdate && summaryValue !== summary) {
      onSummaryUpdate(nodeId, summaryValue.trim() || null);
    }
  };

  if (!editor) {
    return null;
  }

  return (
    <div style={{ position: 'relative', width: '100%' }}>

      {/* Title and Summary Header */}
      {(showTitle || showSummary) && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: compact ? '12px' : '24px',
            marginBottom: compact ? '12px' : '20px',
            padding: compact ? '16px 24px' : '0',
            borderBottom: compact ? '1px solid rgba(184, 153, 104, 0.15)' : 'none',
          }}
        >
          {/* Title */}
          {showTitle && (
            <div style={{ flex: 1 }}>
              {editableTitle ? (
                <input
                  type="text"
                  value={titleValue}
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
                      setEditingTitle(false);
                    }
                  }}
                  onFocus={(e) => e.target.select()}
                  autoFocus
                  style={{
                    width: '100%',
                    fontSize: compact ? 20 : 28,
                    fontWeight: 700,
                    color: '#2a1a0a',
                    border: '2px solid var(--accent, #b89968)',
                    borderRadius: 8,
                    padding: '8px 12px',
                    outline: 'none',
                    background: '#fefdfb',
                  }}
                />
              ) : (
                <div
                  onClick={() => editableTitle && setEditingTitle(true)}
                  style={{
                    fontSize: compact ? 20 : 28,
                    fontWeight: 600,
                    color: '#1a1625',
                    cursor: editableTitle ? 'pointer' : 'default',
                    padding: '8px 12px',
                    borderRadius: 8,
                    transition: 'background 0.15s ease',
                    minHeight: compact ? 36 : 48,
                  }}
                  onMouseEnter={(e) => {
                    if (editableTitle) {
                      e.currentTarget.style.background = 'rgba(139, 127, 168, 0.08)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {titleValue || 'Untitled Chapter'}
                </div>
              )}
            </div>
          )}

          {/* Summary */}
          {showSummary && (
            <div style={{ flex: 1 }}>
              {editingSummary && editableSummary ? (
                <textarea
                  value={summaryValue}
                  onChange={(e) => setSummaryValue(e.target.value)}
                  onBlur={handleSummarySave}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSummaryValue(summary);
                      setEditingSummary(false);
                    }
                  }}
                  autoFocus
                  style={{
                    width: '100%',
                    minHeight: compact ? 60 : 80,
                    fontSize: 14,
                    fontWeight: 400,
                    color: '#5a4a3a',
                    border: '2px solid var(--accent, #b89968)',
                    borderRadius: 8,
                    padding: '8px 12px',
                    outline: 'none',
                    background: '#fefdfb',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                  }}
                />
              ) : (
                <div
                  onClick={() => editableSummary && setEditingSummary(true)}
                  style={{
                    fontSize: 14,
                    fontWeight: 400,
                    color: compact ? 'rgba(0, 0, 0, 0.55)' : '#4a4358',
                    fontStyle: compact ? 'italic' : 'normal',
                    cursor: editableSummary ? 'pointer' : 'default',
                    padding: '8px 12px',
                    borderRadius: 8,
                    transition: 'background 0.15s ease',
                    minHeight: compact ? 36 : 48,
                    lineHeight: 1.6,
                  }}
                  onMouseEnter={(e) => {
                    if (editableSummary) {
                      e.currentTarget.style.background = 'rgba(139, 127, 168, 0.08)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {summaryValue || (editableSummary ? 'Click to add summary...' : '')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Editor Content */}
      <div style={{ padding: compact ? '16px 24px' : '0' }}>
        <EditorContent editor={editor} />
      </div>

      {/* Tags */}
      {showTags && (
        <div
          style={{
            marginTop: compact ? 12 : 20,
            padding: compact ? '12px 24px' : '0',
            borderTop: compact ? '1px solid rgba(184, 153, 104, 0.15)' : 'none',
          }}
        >
          <TagEditor type="node" entityId={nodeId} />
        </div>
      )}
    </div>
  );
}
