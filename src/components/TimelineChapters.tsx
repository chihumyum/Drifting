import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store';
import { useStoryThreadUsecases } from '../hooks/useStoryThreadUsecases';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import type { StoryThread } from '../domain/story_thread';
import type { BookNode } from '../domain/book_node';

const PROJECT_ID = 'default-project';

// Timeline 配置
const TIMELINE_CONFIG = {
  GRID_UNIT: 20, // 每个网格单位占用的像素宽度（从40改为20，提高精度）
  NODE_MIN_WIDTH: 40, // 节点最小宽度（2个网格单位）
  NODE_DEFAULT_WIDTH: 4, // 节点默认宽度（4个网格单位 = 80px）
  NODE_MIN_HEIGHT: 24, // 节点最小高度（太小就不显示文字）
  NODE_EXPANDED_HEIGHT: 60, // 展开时节点理想高度
  NODE_COMPACT_HEIGHT: 32, // 收起时节点理想高度
  THREAD_PADDING: 4, // 每个 thread 行的上下内边距（减小以更紧凑）
  THREAD_GAP: 2, // thread 之间的间隔（减小以更紧凑）
  TIMELINE_PADDING: 16, // Timeline 左右内边距
  RESIZE_HANDLE_WIDTH: 8, // 调整大小手柄的宽度
};

interface TimelineNode extends BookNode {
  threads: StoryThread[];
}

export function TimelineChapters() {
  const navigate = useNavigate();
  const { bookNodes, selectedNodeId } = useAppStore();
  const threadUsecases = useStoryThreadUsecases();
  const nodeUsecases = useBookNodeUsecases();
  
  const [threads, setThreads] = useState<StoryThread[]>([]);
  const [nodesWithThreads, setNodesWithThreads] = useState<TimelineNode[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const [hoveredPosition, setHoveredPosition] = useState<{ threadId: string; start: number; x: number } | null>(null);
  const [draggedNode, setDraggedNode] = useState<{ node: TimelineNode; threadId: string } | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<{ threadId: string; start: number; x: number } | null>(null);
  const [nodeHeight, setNodeHeight] = useState(TIMELINE_CONFIG.NODE_COMPACT_HEIGHT);
  const [needsScroll, setNeedsScroll] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ nodeId: string; threadId: string } | null>(null);
  
  // 节点边缘 hover 状态
  const [hoveredEdge, setHoveredEdge] = useState<{ nodeId: string; edge: 'left' | 'right' } | null>(null);
  
  // 节点宽度（以 grid 单位计）- 使用 Map 存储每个节点的 end 值
  const [nodeEnds, setNodeEnds] = useState<Map<string, number | null>>(new Map());
  
  // 调整大小的状态
  const [resizingNode, setResizingNode] = useState<{
    nodeId: string;
    threadId: string;
    edge: 'left' | 'right';
    startX: number;
    startStart: number;
    startEnd: number | null;
  } | null>(null);
  
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
  // Save scroll position to localStorage
  const saveScrollPosition = useCallback(() => {
    if (scrollContainerRef.current) {
      const scrollLeft = scrollContainerRef.current.scrollLeft;
      localStorage.setItem('timeline-scroll-position', scrollLeft.toString());
    }
  }, []);
  
  // Restore scroll position from localStorage
  useEffect(() => {
    const savedPosition = localStorage.getItem('timeline-scroll-position');
    if (savedPosition && scrollContainerRef.current) {
      scrollContainerRef.current.scrollLeft = parseInt(savedPosition, 10);
    }
  }, [threads.length]); // Restore after threads are loaded
  
  // Save scroll position on scroll
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    
    let timeoutId: number;
    const handleScroll = () => {
      clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        saveScrollPosition();
      }, 300); // Debounce saves
    };
    
    container.addEventListener('scroll', handleScroll);
    return () => {
      container.removeEventListener('scroll', handleScroll);
      clearTimeout(timeoutId);
    };
  }, [saveScrollPosition]);
  
  // 提取重新加载节点数据的逻辑
  const reloadNodesWithThreads = useCallback(async () => {
    try {
      const nodesWithThreadInfo = await Promise.all(
        bookNodes.map(async (node) => {
          const nodeThreads = await threadUsecases.getThreadsByNode(node.id);
          return { ...node, threads: nodeThreads };
        })
      );
      setNodesWithThreads(nodesWithThreadInfo);
    } catch (error) {
      console.error('Failed to reload nodes with threads:', error);
    }
  }, [bookNodes, threadUsecases]);
  
  // 获取节点宽度（像素）
  const getNodeWidth = (nodeId: string): number => {
    const node = nodesWithThreads.find(n => n.id === nodeId);
    if (!node) return TIMELINE_CONFIG.NODE_DEFAULT_WIDTH * TIMELINE_CONFIG.GRID_UNIT;
    
    const end = nodeEnds.get(nodeId) ?? node.end;
    if (end === null || end === undefined) {
      return TIMELINE_CONFIG.NODE_DEFAULT_WIDTH * TIMELINE_CONFIG.GRID_UNIT;
    }
    
    const width = (end - node.start) * TIMELINE_CONFIG.GRID_UNIT;
    return Math.max(width, TIMELINE_CONFIG.NODE_MIN_WIDTH);
  };

  // 计算最大 start 值
  const maxStart = Math.max(...nodesWithThreads.map(n => n.end ?? (n.start + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH)), 0);
  // 计算 timeline 宽度
  const timelineWidth = maxStart * TIMELINE_CONFIG.GRID_UNIT + 40; // 40px 额外空间

  // 动态计算节点高度
  useEffect(() => {
    if (threads.length === 0) return;
    
    const availableHeight = isExpanded ? 280 : 120;
    const headerHeight = isExpanded ? 20 : 0; // thread 标签高度
    const totalPadding = threads.length * TIMELINE_CONFIG.THREAD_PADDING * 2 + (threads.length - 1) * TIMELINE_CONFIG.THREAD_GAP;
    const availableForNodes = availableHeight - totalPadding - (isExpanded ? 32 : 16); // 减去上下 padding
    
    const targetHeight = isExpanded ? TIMELINE_CONFIG.NODE_EXPANDED_HEIGHT : TIMELINE_CONFIG.NODE_COMPACT_HEIGHT;
    const calculatedHeight = Math.max(availableForNodes / threads.length - headerHeight, TIMELINE_CONFIG.NODE_MIN_HEIGHT);
    
    // 如果计算出的高度小于最小高度，说明需要滚动
    if (calculatedHeight < targetHeight) {
      setNeedsScroll(true);
      setNodeHeight(targetHeight); // 使用目标高度，允许滚动
    } else {
      setNeedsScroll(false);
      setNodeHeight(Math.min(calculatedHeight, targetHeight)); // 使用计算高度但不超过目标高度
    }
  }, [threads.length, isExpanded]);

  // Load chapters first
  useEffect(() => {
    async function loadChapters() {
      try {
        await nodeUsecases.loadNodes();
      } catch (error) {
        console.error('Failed to load chapters:', error);
      }
    }
    loadChapters();
  }, [nodeUsecases]);

  // Load threads and node-thread relationships
  useEffect(() => {
    async function loadData() {
      try {
        const allThreads = await threadUsecases.getThreadsByProject(PROJECT_ID);
        setThreads(allThreads);

        // Load thread info for each node
        const nodesWithThreadInfo = await Promise.all(
          bookNodes.map(async (node) => {
            const nodeThreads = await threadUsecases.getThreadsByNode(node.id);
            return { ...node, threads: nodeThreads };
          })
        );
        setNodesWithThreads(nodesWithThreadInfo);
        
        // Initialize end state from database
        const endsMap = new Map<string, number | null>();
        bookNodes.forEach((node) => {
          endsMap.set(node.id, node.end ?? null);
        });
        setNodeEnds(endsMap);
      } catch (error) {
        console.error('Failed to load timeline data:', error);
      }
    }
    
    if (bookNodes.length > 0) {
      loadData();
    }
  }, [bookNodes, threadUsecases]);

  // 将 start 转换为像素位置
  const startToPosition = (start: number) => {
    return (start - 1) * TIMELINE_CONFIG.GRID_UNIT;
  };

  // Handle drag start
  const handleDragStart = (e: React.DragEvent, node: TimelineNode, threadId: string) => {
    setDraggedNode({ node, threadId });
    e.dataTransfer.effectAllowed = 'move';
  };

  // Handle drag over - 计算应该放在哪个 start 位置
  const handleDragOver = (e: React.DragEvent, threadId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    if (!draggedNode) return;
    
    // 获取节点容器的位置（不是整个 timeline）
    const container = (e.currentTarget as HTMLElement).querySelector('[data-node-container]') as HTMLElement;
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left; // 鼠标相对于节点容器的位置
    
    // 从鼠标位置（节点中心）反推节点左边缘的位置
    const nodeWidth = getNodeWidth(draggedNode.node.id);
    const nodeLeftX = mouseX - nodeWidth / 2;
    const start = Math.max(1, Math.round(nodeLeftX / TIMELINE_CONFIG.GRID_UNIT) + 1);
    
    setDragOverPosition({ threadId, start, x: mouseX });
  };

  // Handle drop
  const handleDrop = async (e: React.DragEvent, targetThreadId: string) => {
    e.preventDefault();
    if (!draggedNode || !dragOverPosition) return;

    const { node, threadId: sourceThreadId } = draggedNode;
    const targetStart = dragOverPosition.start;
    
    try {
      // If dropped in a different thread, update threads
      if (sourceThreadId !== targetThreadId) {
        await threadUsecases.addNodeToThread(node.id, targetThreadId);
        await threadUsecases.removeNodeFromThread(node.id, sourceThreadId);
      }

      // Update start if changed
      if (targetStart !== node.start) {
        // Calculate new end to maintain width
        const currentEnd = nodeEnds.get(node.id) ?? node.end;
        const width = currentEnd !== null ? currentEnd - node.start : TIMELINE_CONFIG.NODE_DEFAULT_WIDTH;
        const newEnd = targetStart + width;
        
        await nodeUsecases.updateNode(node.id, { start: targetStart, end: newEnd });
      }

      // Reload data
      await nodeUsecases.loadNodes();
    } catch (error) {
      console.error('Failed to handle drop:', error);
    } finally {
      setDraggedNode(null);
      setDragOverPosition(null);
    }
  };

  const handleDragEnd = () => {
    setDraggedNode(null);
    setDragOverPosition(null);
  };

  // Handle resize start
  const handleResizeStart = (e: React.MouseEvent, nodeId: string, threadId: string, edge: 'left' | 'right') => {
    e.stopPropagation();
    e.preventDefault();
    
    const node = nodesWithThreads.find((n) => n.id === nodeId);
    if (!node) return;
    
    const end = nodeEnds.get(nodeId) ?? node.end ?? (node.start + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH);
    
    setResizingNode({
      nodeId,
      threadId,
      edge,
      startX: e.clientX,
      startStart: node.start,
      startEnd: end,
    });
  };

  // Handle resize move - 添加到 document 上的监听
  useEffect(() => {
    let lastUpdateTime = 0;
    const UPDATE_THROTTLE = 16; // ~60fps
    
    const handleResizeMove = (e: MouseEvent) => {
      if (!resizingNode || !timelineRef.current) return;
      
      // 节流优化 - 限制更新频率
      const now = Date.now();
      if (now - lastUpdateTime < UPDATE_THROTTLE) return;
      lastUpdateTime = now;
      
      const deltaX = e.clientX - resizingNode.startX;
      const deltaGridUnits = Math.round(deltaX / TIMELINE_CONFIG.GRID_UNIT);
      
      if (resizingNode.edge === 'right') {
        // 调整右侧 - 只改变 end，start 保持不变
        const newEnd = Math.max(resizingNode.startStart + 1, (resizingNode.startEnd ?? (resizingNode.startStart + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH)) + deltaGridUnits);
        setNodeEnds((prev) => {
          const next = new Map(prev);
          next.set(resizingNode.nodeId, newEnd);
          return next;
        });
      } else {
        // 调整左侧 - 只改变 start，end 保持不变
        const newStart = Math.max(1, resizingNode.startStart + deltaGridUnits);
        const originalEnd = resizingNode.startEnd ?? (resizingNode.startStart + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH);
        
        // 确保 start 不会超过 end
        const validStart = Math.min(newStart, originalEnd - 1);
        
        // 只更新节点位置，end 保持不变
        setNodesWithThreads((prev) => 
          prev.map((n) => 
            n.id === resizingNode.nodeId ? { ...n, start: validStart } : n
          )
        );
      }
    };
    
    const handleResizeEnd = async () => {
      if (resizingNode) {
        const node = nodesWithThreads.find((n) => n.id === resizingNode.nodeId);
        if (!node) {
          setResizingNode(null);
          return;
        }

        // 获取当前的 end
        const currentEnd = nodeEnds.get(resizingNode.nodeId) ?? node.end;
        
        // 准备更新数据
        const updates: { start?: number; end?: number | null } = {};
        
        // 如果 start 变化了，更新它
        if (node.start !== resizingNode.startStart) {
          updates.start = node.start;
        }
        
        // 如果 end 变化了，更新它
        if (currentEnd !== resizingNode.startEnd) {
          updates.end = currentEnd;
        }
        
        // 如果有任何更新，写入数据库
        if (Object.keys(updates).length > 0) {
          await nodeUsecases.updateNode(resizingNode.nodeId, updates);
        }
        
        // 重新加载数据确保同步
        await nodeUsecases.loadNodes();
        setResizingNode(null);
      }
    };
    
    if (resizingNode) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
      
      return () => {
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleResizeEnd);
      };
    }
  }, [resizingNode, nodeUsecases, nodesWithThreads, nodeEnds]);

  // Handle remove node from thread
  const handleRemoveNodeFromThread = async (nodeId: string, threadId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡，避免取消选择
    const node = nodesWithThreads.find((n) => n.id === nodeId);
    if (!node) return;

    // 如果只有一个 thread，需要二次确认删除节点
    if (node.threads.length === 1) {
      if (showDeleteConfirm?.nodeId === nodeId && showDeleteConfirm?.threadId === threadId) {
        // 二次确认 - 删除整个节点
        try {
          console.log('[TimelineChapters] Deleting node:', nodeId);
          await nodeUsecases.deleteNode(nodeId);
          console.log('[TimelineChapters] Delete successful, clearing selection');
          
          // 清除选中状态并导航到编辑器根路径
          if (selectedNodeId === nodeId) {
            useAppStore.getState().setSelectedNodeId(null);
            navigate('/editor');
          }
          
          setShowDeleteConfirm(null);
          
          // 重新加载节点数据
          console.log('[TimelineChapters] Reloading nodes from database');
          await nodeUsecases.loadNodes();
          console.log('[TimelineChapters] Nodes reloaded');
        } catch (error) {
          console.error('[TimelineChapters] Failed to delete node:', error);
        }
      } else {
        // 第一次点击 - 显示确认状态
        setShowDeleteConfirm({ nodeId, threadId });
        // 3秒后自动取消确认状态
        setTimeout(() => {
          setShowDeleteConfirm((prev) => {
            // 只有当前确认状态还是这个节点时才清除
            if (prev?.nodeId === nodeId && prev?.threadId === threadId) {
              return null;
            }
            return prev;
          });
        }, 3000);
      }
      return;
    }

    // 多个 thread，直接移除关联
    try {
      await threadUsecases.removeNodeFromThread(nodeId, threadId);
      
      // Reload
      await reloadNodesWithThreads();
    } catch (error) {
      console.error('Failed to remove node from thread:', error);
    }
  };

  // Handle add selected node to thread
  const handleAddSelectedNodeToThread = async (threadId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡，避免取消选择
    if (!selectedNodeId) return;

    try {
      await threadUsecases.addNodeToThread(selectedNodeId, threadId);
      
      // Reload
      await reloadNodesWithThreads();
    } catch (error) {
      console.error('Failed to add node to thread:', error);
    }
  };

  // Handle node click
  const handleNodeClick = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡到 timeline 背景
    // 设置选中状态
    useAppStore.getState().setSelectedNodeId(nodeId);
    // 导航到编辑器
    navigate(`/editor/${nodeId}`);
  };

  // Handle timeline background click (deselect)
  const handleTimelineClick = () => {
    // 点击任何空白处都取消选择（事件会被节点和按钮拦截）
    useAppStore.getState().setSelectedNodeId(null);
  };

  // Render a single node card
  const renderNodeCard = (node: TimelineNode, threadId: string) => {
    const thread = threads.find((t) => t.id === threadId);
    const isHovered = hoveredNodeId === node.id;
    const isDragging = draggedNode?.node.id === node.id;
    const isSelected = selectedNodeId === node.id;
    const isConfirmingDelete = showDeleteConfirm?.nodeId === node.id && showDeleteConfirm?.threadId === threadId;
    
    const leftPosition = startToPosition(node.start);
    const nodeWidth = getNodeWidth(node.id);
    const showText = nodeHeight >= TIMELINE_CONFIG.NODE_MIN_HEIGHT;
    
    // 检测当前节点是否有边缘 hover
    const edgeHover = hoveredEdge?.nodeId === node.id ? hoveredEdge.edge : null;
    
    const handleMouseMove = (e: React.MouseEvent) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const edgeWidth = TIMELINE_CONFIG.RESIZE_HANDLE_WIDTH;
      
      if (x <= edgeWidth) {
        setHoveredEdge({ nodeId: node.id, edge: 'left' });
      } else if (x >= nodeWidth - edgeWidth) {
        setHoveredEdge({ nodeId: node.id, edge: 'right' });
      } else {
        setHoveredEdge(null);
      }
    };

    return (
      <div
        key={`${node.id}-${threadId}`}
        draggable={!edgeHover}
        onDragStart={(e) => handleDragStart(e, node, threadId)}
        onDragEnd={handleDragEnd}
        onMouseEnter={() => {
          setHoveredNodeId(node.id);
          setHoveredThreadId(threadId);
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          setHoveredNodeId(null);
          setHoveredThreadId(null);
          setHoveredEdge(null);
        }}
        onMouseDown={(e) => {
          if (edgeHover) {
            handleResizeStart(e, node.id, threadId, edgeHover);
          }
        }}
        onClick={(e) => {
          if (!edgeHover) {
            handleNodeClick(node.id, e);
          }
        }}
        style={{
          position: 'absolute',
          left: leftPosition,
          top: 0,
          width: nodeWidth,
          height: nodeHeight,
          background: `${thread?.color || '#A5B4FC'}20`,
          borderRadius: 6,
          padding: showText ? (isExpanded ? '8px 10px' : '4px 8px') : 0,
          display: 'flex',
          flexDirection: 'column',
          gap: showText ? 4 : 0,
          cursor: edgeHover ? 'ew-resize' : 'grab',
          opacity: isDragging ? 0.5 : 1,
          // 拆分 border 为单独的属性以避免冲突
          borderTop: isSelected ? `2px solid ${thread?.color || '#A5B4FC'}` : `1px solid ${thread?.color || '#A5B4FC'}40`,
          borderBottom: isSelected ? `2px solid ${thread?.color || '#A5B4FC'}` : `1px solid ${thread?.color || '#A5B4FC'}40`,
          borderLeft: edgeHover === 'left' 
            ? `3px solid ${thread?.color || '#A5B4FC'}` 
            : (isSelected ? `2px solid ${thread?.color || '#A5B4FC'}` : `1px solid ${thread?.color || '#A5B4FC'}40`),
          borderRight: edgeHover === 'right' 
            ? `3px solid ${thread?.color || '#A5B4FC'}` 
            : (isSelected ? `2px solid ${thread?.color || '#A5B4FC'}` : `1px solid ${thread?.color || '#A5B4FC'}40`),
          boxShadow: isSelected ? `0 2px 8px ${thread?.color || '#A5B4FC'}40` : '0 1px 4px rgba(100, 90, 120, 0.08)',
          transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          overflow: 'visible',
        }}
      >
        {showText && (
          <>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'rgba(71, 71, 71, 0.85)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                lineHeight: 1.3,
              }}
            >
              {node.title}
            </div>
            
            {isExpanded && node.summary && nodeHeight >= TIMELINE_CONFIG.NODE_EXPANDED_HEIGHT && (
              <div
                style={{
                  fontSize: 9,
                  color: 'rgba(71, 71, 71, 0.65)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  lineHeight: 1.3,
                }}
              >
                {node.summary}
              </div>
            )}
          </>
        )}

        {/* 删除按钮 - 仅在 hover 当前 thread 的已选中 node 时显示 */}
        {isSelected && isHovered && hoveredThreadId === threadId && (
          <button
            onClick={(e) => handleRemoveNodeFromThread(node.id, threadId, e)}
            style={{
              position: 'absolute',
              top: -8,
              right: -8,
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: isConfirmingDelete ? '#EF4444' : 'rgba(71, 71, 71, 0.85)',
              border: `2px solid ${thread?.color || '#A5B4FC'}`,
              color: '#fff',
              fontSize: 12,
              fontWeight: 'bold',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 101,
              transition: 'all 0.2s',
              padding: 0,
            }}
            title={node.threads.length === 1 ? 'Delete node (click twice to confirm)' : 'Remove from this thread'}
          >
            {isConfirmingDelete ? '!' : '×'}
          </button>
        )}
      </div>
    );
  };

  // Render a single thread row using absolute positioning
  const renderThreadRow = (thread: StoryThread) => {
    const nodesInThread = nodesWithThreads.filter((n) => n.threads.some((t) => t.id === thread.id));
    const rowHeight = nodeHeight + TIMELINE_CONFIG.THREAD_PADDING * 2;
    
    // 检查选中的节点是否属于当前 thread
    const selectedNode = nodesWithThreads.find((n) => n.id === selectedNodeId);
    const selectedNodeBelongsToThread = selectedNode?.threads.some((t) => t.id === thread.id);
    
    // 计算选中节点的有效添加区域
    const selectedNodeLeft = selectedNode ? startToPosition(selectedNode.start) : 0;
    const selectedNodeWidth = selectedNode ? getNodeWidth(selectedNode.id) : 0;
    const selectedNodeRight = selectedNodeLeft + selectedNodeWidth;
    const isInValidAddZone = hoveredPosition?.threadId === thread.id && 
                             hoveredPosition.x >= selectedNodeLeft && 
                             hoveredPosition.x <= selectedNodeRight;
    
    const shouldShowAddButton = selectedNodeId && !selectedNodeBelongsToThread && isInValidAddZone;

    return (
      <div
        key={thread.id}
        onDragOver={(e) => handleDragOver(e, thread.id)}
        onDrop={(e) => handleDrop(e, thread.id)}
        onClick={handleTimelineClick}
        onMouseMove={(e) => {
          if (!selectedNodeId || selectedNodeBelongsToThread) return;
          
          const container = e.currentTarget.querySelector('[data-node-container]') as HTMLElement;
          if (!container) return;
          
          const rect = container.getBoundingClientRect();
          const x = e.clientX - rect.left;
          
          setHoveredPosition({ threadId: thread.id, start: selectedNode?.start || 1, x });
        }}
        onMouseLeave={() => {
          setHoveredPosition(null);
        }}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          height: rowHeight,
          marginBottom: TIMELINE_CONFIG.THREAD_GAP,
          gap: 12,
        }}
      >
        {/* Thread label - 放在左侧 */}
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'rgba(71, 71, 71, 0.85)',
            width: 60, // 固定宽度，确保所有 thread 对齐
            flexShrink: 0, // 防止被压缩
            textAlign: 'right',
            paddingRight: 8,
            opacity: isExpanded ? 1 : 0.6,
            transition: 'opacity 0.3s',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {thread.name}
        </div>

        {/* Node container with absolute positioning */}
        <div
          data-node-container
          style={{
            position: 'relative',
            flex: 1,
            height: nodeHeight,
            background: 'rgba(200, 190, 220, 0.08)',
            borderRadius: 4,
            minWidth: timelineWidth,
          }}
        >
          {/* Render drop indicator */}
          {dragOverPosition?.threadId === thread.id && (
            <div
              style={{
                position: 'absolute',
                left: dragOverPosition.x,
                top: 0,
                width: 2,
                height: nodeHeight,
                background: thread.color || '#A5B4FC',
                opacity: 0.7,
                pointerEvents: 'none',
              }}
            />
          )}

          {/* 添加按钮 - 当选中的节点不属于当前 thread 时显示 */}
          {shouldShowAddButton && selectedNode && (
            <button
              onClick={(e) => handleAddSelectedNodeToThread(thread.id, e)}
              style={{
                position: 'absolute',
                left: startToPosition(selectedNode.start) + getNodeWidth(selectedNode.id) / 2,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: thread.color || '#A5B4FC',
                border: '2px solid rgba(240, 240, 245, 0.95)',
                color: '#fff',
                fontSize: 20,
                fontWeight: 'bold',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 102,
                transition: 'all 0.2s',
                padding: 0,
                boxShadow: '0 2px 8px rgba(100, 90, 120, 0.2)',
              }}
              title="Add selected node to this thread"
            >
              +
            </button>
          )}

          {/* Render nodes */}
          {nodesInThread.map((node) => renderNodeCard(node, thread.id))}

          {/* Empty state */}
          {nodesInThread.length === 0 && !draggedNode && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                fontSize: 11,
                color: 'rgba(71, 71, 71, 0.35)',
                fontStyle: 'italic',
                whiteSpace: 'nowrap',
              }}
            >
              No chapters in this thread
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={timelineRef}
      onClick={handleTimelineClick}
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => {
        setIsExpanded(false);
        setHoveredNodeId(null);
      }}
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: isExpanded ? 280 : 120,
        background: 'linear-gradient(to top, rgba(240, 240, 245, 0.98), rgba(245, 245, 250, 0.95))',
        borderTop: '1px solid rgba(200, 190, 220, 0.25)',
        transition: 'height 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
        zIndex: 20,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        padding: isExpanded ? '16px 0' : '12px 0',
      }}
    >
      <div
        ref={scrollContainerRef}
        data-timeline-container
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflowX: 'auto',
          overflowY: isExpanded && needsScroll ? 'auto' : 'hidden',
          paddingRight: 12,
          // 隐藏滚动条但保持滚动功能
          scrollbarWidth: 'none', // Firefox
          msOverflowStyle: 'none', // IE and Edge
          WebkitOverflowScrolling: 'touch', // iOS smooth scrolling
        }}
        // 隐藏滚动条 - Webkit (Chrome, Safari)
        className="timeline-scroll-container"
      >
        {threads.length > 0 ? (
          threads.map((thread) => renderThreadRow(thread))
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'rgba(71, 71, 71, 0.5)',
              fontSize: 14,
            }}
          >
            Loading story threads...
          </div>
        )}
      </div>
    </div>
  );
}
