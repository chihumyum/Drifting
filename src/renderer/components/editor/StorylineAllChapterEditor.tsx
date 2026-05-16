import { useEffect, useRef, useState, useCallback } from 'react';
import loglevel from 'loglevel';

const log = loglevel.getLogger('StorylineAllChapterEditor');
log.setLevel(loglevel.levels.ERROR);
import type { BookNode } from '../../domain/book-node';
import { useBookContent } from '../../usecase/useBookContent';
import { ChapterSection } from './ChapterSection';
import { useAuthStore } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';

interface StorylineAllChapterProps {
  nodes: BookNode[]; // 已按顺序排列的章节列表
  onCurrentChapterChange?: (nodeId: string, index: number) => void; // 当前编辑的章节变化回调
}

interface ChapterData {
  nodeId: string;
  node: BookNode;
  content: string | null; // pm_json
}

export function StorylineAllChapterEditor({
  nodes,
  onCurrentChapterChange,
}: StorylineAllChapterProps) {
  const userId = useAuthStore((state) => state.user?.id);
  const { projectId } = useProjectNavigation();
  const { updateContentByNodeId, createContent, getContentByNodeId } = useBookContent({
    userId: userId ?? '',
    projectId: projectId ?? '',
  });
  const [chaptersData, setChaptersData] = useState<ChapterData[]>([]);
  const [currentChapterIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 加载所有章节的内容
  useEffect(() => {
    let isMounted = true;

    async function loadAllContents() {
      const dataPromises = nodes.map(async (node) => {
        try {
          const content = await getContentByNodeId(node.id);
          return {
            nodeId: node.id,
            node,
            content: content?.contentJson || null,
          };
        } catch (error) {
          log.error(`Failed to load content for node ${node.id}:`, error);
          return {
            nodeId: node.id,
            node,
            content: null,
          };
        }
      });

      const data = await Promise.all(dataPromises);
      if (isMounted) {
        setChaptersData(data);
      }
    }

    if (nodes.length > 0) {
      loadAllContents();
    }

    return () => {
      isMounted = false;
    };
  }, [nodes, getContentByNodeId]);

  // 内容更新处理
  const handleContentUpdate = useCallback(
    async (nodeId: string, pmJson: string, outlineJson: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      // 先尝试获取现有内容以判断是更新还是创建
      const existingContent = await getContentByNodeId(nodeId);

      if (existingContent) {
        await updateContentByNodeId(nodeId, {
          contentJson: pmJson,
          outlineJson,
        });
      } else {
        // 创建新内容
        await createContent(nodeId, { contentJson: pmJson, outlineJson });
      }

      // 更新本地状态
      setChaptersData((prev) =>
        prev.map((item) => (item.nodeId === nodeId ? { ...item, content: pmJson } : item)),
      );
    },
    [nodes, getContentByNodeId, updateContentByNodeId, createContent],
  );

  // 滚动到指定章节
  const scrollToChapter = useCallback((index: number) => {
    const elements = containerRef.current?.querySelectorAll('[data-chapter-index]');
    if (elements && elements[index]) {
      elements[index].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  // 暴露scrollToChapter方法给父组件
  useEffect(() => {
    if (containerRef.current) {
      // @ts-expect-error - 添加自定义方法
      containerRef.current.scrollToChapter = scrollToChapter;
    }
  }, [scrollToChapter]);

  useEffect(() => {
    if (!onCurrentChapterChange) return;
    const current = chaptersData[currentChapterIndex];
    if (!current) return;
    onCurrentChapterChange(current.nodeId, currentChapterIndex);
  }, [onCurrentChapterChange, chaptersData, currentChapterIndex]);

  if (chaptersData.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'rgba(0, 0, 0, 0.45)',
          fontSize: 14,
        }}
      >
        No chapters in this storyline
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ height: '100%', width: '100%', overflowY: 'auto' }}>
      {chaptersData.map((chapterData, index) => (
        <div key={chapterData.nodeId} data-chapter-index={index}>
          <ChapterSection
            node={chapterData.node}
            content={chapterData.content}
            onContentUpdate={handleContentUpdate}
            isActive={index === currentChapterIndex}
            showDivider={index < chaptersData.length - 1}
          />
        </div>
      ))}
    </div>
  );
}
