import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { NodeType, NodeStatus } from '../lib/schema';
import { BookOpen, FileText, Zap } from 'lucide-react';

interface StoryNodeData {
  label: string;
  type: NodeType;
  status: NodeStatus;
  summary?: string;
}

const nodeIcons = {
  chapter: BookOpen,
  scene: FileText,
  beat: Zap,
};

const nodeColors = {
  chapter: 'bg-blue-100 border-blue-300 text-blue-900',
  scene: 'bg-green-100 border-green-300 text-green-900',
  beat: 'bg-purple-100 border-purple-300 text-purple-900',
};

const statusColors = {
  draft: 'bg-gray-200',
  in_progress: 'bg-yellow-200',
  complete: 'bg-green-200',
  archived: 'bg-gray-300',
};

export const StoryNode = memo(({ data, selected }: NodeProps<StoryNodeData>) => {
  const Icon = nodeIcons[data.type];
  const colorClass = nodeColors[data.type];
  const statusClass = statusColors[data.status];

  return (
    <div className={`
      relative min-w-[200px] rounded-lg border-2 p-3 shadow-sm
      ${colorClass}
      ${selected ? 'ring-2 ring-blue-500' : ''}
    `}>
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      
      <div className="flex items-start gap-2">
        <Icon size={16} className="mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{data.label}</div>
          <div className="text-xs opacity-70 capitalize">{data.type}</div>
          {data.summary && (
            <div className="text-xs mt-1 line-clamp-2 opacity-80">
              {data.summary}
            </div>
          )}
        </div>
      </div>
      
      <div className={`absolute top-1 right-1 w-2 h-2 rounded-full ${statusClass}`} />
      
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
});

StoryNode.displayName = 'StoryNode';