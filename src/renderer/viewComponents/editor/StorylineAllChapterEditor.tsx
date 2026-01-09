import { useEffect, useRef, useState, useCallback } from 'react';
import log from 'loglevel';
log.setLevel(log.levels.ERROR);
import type { BookNode } from '../../domain/book-node';

import { useBookContentUsecases } from '../../hooks/useBookContentUsecases';
import { ChapterSection } from './ChapterSection';
import { useAppStore } from '../../store';
import { createBookContentRepository } from '../../repositories/book_content_sqlite';

interface StorylineAllChapterProps {
  nodes: BookNode[]; // 已按顺序排列的章节列表
  onCurrentChapterChange?: (nodeId: string, index: number) => void; // 当前编辑的章节变化回调
}

interface ChapterData {
  nodeId: string;
  node: BookNode;
  content: string | null; // pm_json
}

export function StorylineAllChapterEditor({ nodes, onCurrentChapterChange }: StorylineAllChapterProps) {
  const bookContent = useAppStore((state) => state.bookContent);
  const { updateContent, newContent } = useBookContentUsecases();
  const [chaptersData, setChaptersData] = useState<ChapterData[]>([]);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRepoRef = useRef(createBookContentRepository());

  // 加载所有章节的内容
  useEffect(() => {
    async function loadAllContents() {
      const contentRepo = contentRepoRef.current;
      const dataPromises = nodes.map(async (node) => {
        try {
          // 直接从repository获取内容，避免store冲突
          const content = await contentRepo.findByNodeId(node.id);
          return {
            nodeId: node.id,
            node,
            content: content?.pmJson || null,
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
      setChaptersData(data);
    }

    if (nodes.length > 0) {
      loadAllContents();
    }
  }, [nodes]);

  // 监听store中的内容变化，更新对应章节
  useEffect(() => {
    if (!bookContent) return;

    setChaptersData((prev) =>
      prev.map((item) =>
        item.nodeId === bookContent.nodeId
          ? { ...item, content: bookContent.pmJson }
          : item
      )
    );
  }, [bookContent]);

  // 内容更新处理
  const handleContentUpdate = useCallback(
    async (nodeId: string, pmJson: string, outlineJson: string) => {
      const contentRepo = contentRepoRef.current;
      // 直接从repository查询内容
      const existingContent = await contentRepo.findByNodeId(nodeId);

      if (existingContent?.id) {
        await updateContent({
          id: existingContent.id,
          nodeId,
          pmJson,
          outlineJson,
        });
      } else {
        // 创建新内容
        await newContent(nodeId, pmJson);
      }

      // 更新本地状态
      setChaptersData((prev) =>
        prev.map((item) =>
          item.nodeId === nodeId
            ? { ...item, content: pmJson }
            : item
        )
      );
    },
    [updateContent, newContent]
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
