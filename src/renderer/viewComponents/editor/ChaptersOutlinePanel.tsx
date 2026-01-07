import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Edit2, Save, X } from 'lucide-react';
import type { BookNode } from '../../domain/book_node';
import type { OutlineItem } from '../../schema/book_content';
import { extractOutline } from '../../lib/outline';

interface ChaptersOutlinePanelProps {
  nodes: BookNode[]; // 章节列表
  contentsMap: Map<string, string>; // nodeId -> pm_json
  currentChapterIndex: number; // 当前章节索引
  onChapterClick: (index: number) => void; // 点击章节跳转
  onOutlineSummaryUpdate?: (nodeId: string, outlineId: string, summary: string) => void; // 更新 outline summary
}

interface ChapterOutlineData {
  node: BookNode;
  outline: OutlineItem[];
  isExpanded: boolean;
}

export function ChaptersOutlinePanel({
  nodes,
  contentsMap,
  currentChapterIndex,
  onChapterClick,
  onOutlineSummaryUpdate,
}: ChaptersOutlinePanelProps) {
  const [chaptersOutline, setChaptersOutline] = useState<ChapterOutlineData[]>([]);
  const [editingSummary, setEditingSummary] = useState<{ nodeId: string; outlineId: string } | null>(null);
  const [summaryInput, setSummaryInput] = useState('');

  // 提取所有章节的outline
  useEffect(() => {
    const outlineData: ChapterOutlineData[] = nodes.map((node, index) => {
      const pmJson = contentsMap.get(node.id);
      const outline = pmJson ? extractOutline(pmJson) : [];
      
      return {
        node,
        outline,
        isExpanded: index === currentChapterIndex, // 默认展开当前章节
      };
    });

    setChaptersOutline(outlineData);
  }, [nodes, contentsMap, currentChapterIndex]);

  // 切换章节展开状态
  const toggleChapter = (index: number) => {
    setChaptersOutline((prev) =>
      prev.map((item, i) =>
        i === index ? { ...item, isExpanded: !item.isExpanded } : item
      )
    );
  };

  // 开始编辑 summary
  const startEditSummary = (nodeId: string, outlineId: string, currentSummary?: string) => {
    setEditingSummary({ nodeId, outlineId });
    setSummaryInput(currentSummary || '');
  };

  // 保存 summary
  const saveSummary = () => {
    if (editingSummary && onOutlineSummaryUpdate) {
      onOutlineSummaryUpdate(editingSummary.nodeId, editingSummary.outlineId, summaryInput);
      setEditingSummary(null);
      setSummaryInput('');
    }
  };

  // 取消编辑
  const cancelEdit = () => {
    setEditingSummary(null);
    setSummaryInput('');
  };

  // 统计章节字数
  const getChapterWordCount = (pmJson: string | undefined): number => {
    if (!pmJson) return 0;
    
    try {
      const json = JSON.parse(pmJson);
      const extractText = (node: any): string => {
        let text = '';
        if (node.type === 'text' && node.text) {
          text += node.text;
        }
        if (node.content) {
          node.content.forEach((child: any) => {
            text += extractText(child);
          });
        }
        return text;
      };
      
      const text = extractText(json);
      // 简单的字数统计（中文字符 + 英文单词）
      const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
      const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
      return chineseChars + englishWords;
    } catch {
      return 0;
    }
  };

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        background: 'rgba(255, 255, 255, 0.5)',
        borderLeft: '1px solid rgba(184, 153, 104, 0.2)',
      }}
    >
      {/* 标题 */}
      <div
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid rgba(184, 153, 104, 0.2)',
          background: 'rgba(251, 249, 243, 1)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 600,
            color: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <FileText size={18} />
          Chapters Outline
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'rgba(0, 0, 0, 0.45)' }}>
          {nodes.length} chapters
        </p>
      </div>

      {/* 章节列表 */}
      <div style={{ padding: '12px 0' }}>
        {chaptersOutline.map((chapter, index) => {
          const isActive = index === currentChapterIndex;
          const wordCount = getChapterWordCount(contentsMap.get(chapter.node.id));
          
          return (
            <div key={chapter.node.id} style={{ marginBottom: 4 }}>
              {/* 章节标题行 */}
              <div
                onClick={() => {
                  toggleChapter(index);
                  onChapterClick(index);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 12px 8px 16px',
                  cursor: 'pointer',
                  background: isActive ? 'rgba(184, 153, 104, 0.15)' : 'transparent',
                  borderLeft: isActive ? '3px solid rgba(184, 153, 104, 1)' : '3px solid transparent',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'rgba(184, 153, 104, 0.08)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'transparent';
                  }
                }}
              >
                {/* 展开/折叠图标 */}
                <div style={{ marginRight: 6, color: 'rgba(0, 0, 0, 0.45)' }}>
                  {chapter.isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </div>

                {/* 章节信息 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: isActive ? 600 : 500,
                      color: isActive ? 'rgba(0, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0.65)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {chapter.node.title || 'Untitled'}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'rgba(0, 0, 0, 0.45)',
                      marginTop: 2,
                    }}
                  >
                    {wordCount} words
                    {chapter.outline.length > 0 && ` • ${chapter.outline.length} sections`}
                  </div>
                </div>
              </div>

              {/* Outline 列表（展开时） */}
              {chapter.isExpanded && chapter.outline.length > 0 && (
                <div style={{ paddingLeft: 28, paddingRight: 12 }}>
                  {chapter.outline.map((item, itemIndex) => {
                    const indent = (item.level - 1) * 12;
                    const isEditing = editingSummary?.nodeId === chapter.node.id && editingSummary?.outlineId === item.id;
                    
                    return (
                      <div
                        key={`${chapter.node.id}-outline-${itemIndex}`}
                        style={{
                          padding: '6px 8px 6px ' + indent + 'px',
                          fontSize: 12,
                          borderRadius: 4,
                          marginBottom: 4,
                          background: isEditing ? 'rgba(184, 153, 104, 0.08)' : 'transparent',
                        }}
                      >
                        {/* Heading 标题 */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            cursor: 'pointer',
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onChapterClick(index);
                          }}
                          onMouseEnter={(e) => {
                            if (!isEditing) {
                              e.currentTarget.parentElement!.style.background = 'rgba(184, 153, 104, 0.08)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isEditing) {
                              e.currentTarget.parentElement!.style.background = 'transparent';
                            }
                          }}
                        >
                          <span
                            style={{
                              flex: 1,
                              fontWeight: item.level === 1 ? 600 : 400,
                              color:
                                item.level === 1
                                  ? 'rgba(0, 0, 0, 0.65)'
                                  : 'rgba(0, 0, 0, 0.50)',
                            }}
                          >
                            {item.text}
                          </span>
                          
                          {/* 编辑按钮 */}
                          {!isEditing && (
                            <Edit2
                              size={14}
                              style={{
                                color: 'rgba(184, 153, 104, 0.6)',
                                cursor: 'pointer',
                                opacity: 0.5,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditSummary(chapter.node.id, item.id, item.summary);
                              }}
                              onMouseEnter={(e) => {
                                const target = e.currentTarget.parentElement;
                                if (target) target.style.opacity = '1';
                              }}
                              onMouseLeave={(e) => {
                                const target = e.currentTarget.parentElement;
                                if (target) target.style.opacity = '0.5';
                              }}
                            />
                          )}
                        </div>

                        {/* Summary 显示/编辑 */}
                        {isEditing ? (
                          <div style={{ marginTop: 6 }}>
                            <textarea
                              value={summaryInput}
                              onChange={(e) => setSummaryInput(e.target.value)}
                              placeholder="Add a summary for this section..."
                              style={{
                                width: '100%',
                                minHeight: 60,
                                padding: 6,
                                fontSize: 11,
                                border: '1px solid rgba(184, 153, 104, 0.3)',
                                borderRadius: 4,
                                resize: 'vertical',
                                fontFamily: 'inherit',
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  saveSummary();
                                }}
                                style={{
                                  flex: 1,
                                  padding: '4px 8px',
                                  fontSize: 11,
                                  background: 'rgba(184, 153, 104, 0.9)',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: 4,
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 4,
                                }}
                              >
                                <Save size={12} />
                                Save
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  cancelEdit();
                                }}
                                style={{
                                  flex: 1,
                                  padding: '4px 8px',
                                  fontSize: 11,
                                  background: 'rgba(0, 0, 0, 0.05)',
                                  color: 'rgba(0, 0, 0, 0.65)',
                                  border: 'none',
                                  borderRadius: 4,
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 4,
                                }}
                              >
                                <X size={12} />
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : item.summary ? (
                          <div
                            style={{
                              marginTop: 4,
                              padding: 6,
                              fontSize: 11,
                              color: 'rgba(0, 0, 0, 0.45)',
                              fontStyle: 'italic',
                              background: 'rgba(184, 153, 104, 0.05)',
                              borderRadius: 4,
                              borderLeft: '2px solid rgba(184, 153, 104, 0.3)',
                            }}
                          >
                            {item.summary}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
