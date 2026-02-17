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
import { createElementOccurrenceRepository } from '../../sqlite-repo/element-occr-repo';
import { useSettingsStore } from '@/renderer/store/settings-store';
import { TagEditor } from './TagEditor';
import loglevel from 'loglevel';
import { useDataStore } from '@/renderer/store/data-store';
const log = loglevel.getLogger('ChapterEditor');
// log.setLevel(loglevel.levels.DEBUG);
log.setLevel(log.levels.WARN);

// editor component with built-in element tracking and outline extraction, and more

interface ChapterEditorProps {
  nodeId: string;
  content: string | null; // pm_json string
  title?: string;
  summary?: string;
  projectId?: string;
  ref?: Ref<ChapterEditorRef>;

  // 内容更新回调
  onContentUpdate: (nodeId: string, pmJson: string, outlineJson: string) => void;
  onTitleUpdate?: (nodeId: string, title: string) => void;
  onSummaryUpdate?: (nodeId: string, summary: string) => void;
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
  projectId,
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
  const { bookElements } = useDataStore();
  const { autoElementLinkEnabled }= useSettingsStore();
  const isContentLoadedRef = useRef(false);
  const parseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
        category: element.categoryId,
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
        const repo = createElementOccurrenceRepository();
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
    content: null,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-none',
        style: `min-height: ${minHeight}`,
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: ed }) => {

      const json = ed.getJSON();
      const pmJson = JSON.stringify(json);

      // TODO: check if we have a performance issue here
      const outline = extractOutline(pmJson);
      log.debug('Extracted outline:', outline);
      const outlineJson = serializeOutline(outline);
      log.debug('Outline JSON:', outlineJson);
      parseAndSaveElementOccurrences(json);
      log.debug('Updating node', nodeId, 'with content:', pmJson);
      onContentUpdate(nodeId, pmJson, outlineJson);
    },
  });

  // load content into editor
  useEffect(() => {
    if (editor && content && !isContentLoadedRef.current) {
      editor.commands.setContent(JSON.parse(content));
      isContentLoadedRef.current = true;
    } else {
      if (!isContentLoadedRef.current) {
        log.error('Editor not ready');
      }
    }
  }, [editor, content]);

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


  // 清理定时器
  useEffect(() => {
    return () => {
      if (parseTimeoutRef.current) {
        clearTimeout(parseTimeoutRef.current);
      }
    };
  }, []);

  const handleTitleSave = () => {
    if (onTitleUpdate && titleValue.trim() && titleValue !== title) {
      onTitleUpdate(nodeId, titleValue.trim());
    }
  };

  const handleSummarySave = () => {
    if (onSummaryUpdate && summaryValue !== summary) {
      onSummaryUpdate(nodeId, summaryValue.trim());
    }
  };

  if (!editor) {
    log.error('Editor not initialized');
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
                      e.currentTarget.blur();
                    }
                  }}
                  onFocus={(e) => e.target.select()}
                  style={{
                    width: '100%',
                    fontSize: compact ? 20 : 28,
                    fontWeight: 700,
                    background: 'transparent',
                    outline: 'none',
                  }}
                />
              ) : (
                <div
                  style={{
                    fontSize: compact ? 20 : 28,
                    fontWeight: 600,
                    background: 'transparent',
                  }}
                >
                  {titleValue || 'Untitled Chapter'}
                </div>
              )}
            </div>
          )}

          {/* Tags */}
          {showTags && (
            <div
              style={{
                padding: compact ? '12px 24px' : '0',
                borderLeft: compact ? '1px solid rgba(184, 153, 104, 0.15)' : 'none',
              }}
            >
              <TagEditor type="node" entityId={nodeId} projectId={projectId} />
            </div>
          )}
          {/* Summary */}
          {showSummary && (
            <div style={{ flex: 1 }}>
              {editableSummary ? (
                <textarea
                  value={summaryValue}
                  onChange={(e) => setSummaryValue(e.target.value)}
                  onBlur={handleSummarySave}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSummaryValue(summary);
                      e.currentTarget.blur();
                    }
                  }}
                  style={{
                    width: '100%',
                    fontSize: 14,
                    fontWeight: 400,
                    background: 'transparent',
                    color: '#5a4a3a',
                    resize: 'none',
                    overflow: 'hidden',
                    outline: 'none',
                  }}
                />
              ) : (
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 400,
                    background: 'transparent',
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

    </div>
  );
}
