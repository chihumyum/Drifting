import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ElementOccurrenceRepository } from '../../repositories/element-occurrence.repository';

interface BacklinksPanelProps {
  elementId: string;
}

interface Backlink {
  id: string;
  node_id: string;
  node_title: string;
  spans_json: string;
  created_at: string;
}

/**
 * 反向链接面板, used in ElementEditorView
 * 显示某个元素在哪些章节中被引用
 */
export function BacklinksPanel({ elementId }: BacklinksPanelProps) {
  const navigate = useNavigate();
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadBacklinks = async () => {
      if (!elementId) {
        setLoading(false);
        return;
      }

      try {
        const repo = new ElementOccurrenceRepository();
        const occurrences = await repo.getOccurrencesByElement(elementId);
        setBacklinks(occurrences);
      } catch (error) {
        console.error('Failed to load backlinks:', error);
      } finally {
        setLoading(false);
      }
    };

    void loadBacklinks();
  }, [elementId]);

  if (loading) {
    return (
      <div className="backlinks-panel p-4">
        <div className="text-sm text-gray-400">加载中...</div>
      </div>
    );
  }

  if (backlinks.length === 0) {
    return (
      <div className="backlinks-panel p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-2">被引用于</h3>
        <div className="text-sm text-gray-500 italic">
          此元素尚未在任何章节中被引用
        </div>
      </div>
    );
  }

  return (
    <div className="backlinks-panel p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">
        被引用于 ({backlinks.length})
      </h3>
      
      <div className="space-y-2">
        {backlinks.map((backlink) => {
          const spans = JSON.parse(backlink.spans_json) as Array<{
            text: string;
            position: number;
            length: number;
          }>;
          const occurrenceCount = spans.length;

          return (
            <div
              key={backlink.id}
              onClick={() => navigate(`/editor/${backlink.node_id}`)}
              className="backlink-item p-3 bg-gray-800 hover:bg-gray-750 rounded cursor-pointer transition-colors group"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="text-sm text-gray-200 group-hover:text-white">
                    {backlink.node_title || '未命名章节'}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    出现 {occurrenceCount} 次
                  </div>
                </div>
                
                <div className="ml-2">
                  <svg
                    className="w-4 h-4 text-gray-500 group-hover:text-gray-300"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
