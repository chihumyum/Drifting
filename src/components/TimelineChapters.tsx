import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store';
import { useStoryThreadUsecases } from '../hooks/useStoryThreadUsecases';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import type { StoryThread } from '../domain/story_thread';
import type { BookNode } from '../domain/book_node';

const PROJECT_ID = 'default-project';

// Timeline 配置
const TIMELINE_CONFIG = {
  GRID_UNIT: 40, // 每个 order_key 单位占用的像素宽度（像视频剪辑软件的网格）
  NODE_MIN_WIDTH: 40, // 节点最小宽度（1个网格单位）
  NODE_DEFAULT_DURATION: 2, // 节点默认持续时长（2个网格单位 = 80px）
  NODE_MIN_HEIGHT: 24, // 节点最小高度（太小就不显示文字）
  NODE_EXPANDED_HEIGHT: 60, // 展开时节点理想高度
  NODE_COMPACT_HEIGHT: 32, // 收起时节点理想高度
  THREAD_PADDING: 8, // 每个 thread 行的上下内边距
  THREAD_GAP: 4, // thread 之间的间隔
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
  const [hoveredPosition, setHoveredPosition] = useState<{ threadId: string; orderKey: number; x: number } | null>(null);
  const [draggedNode, setDraggedNode] = useState<{ node: TimelineNode; threadId: string } | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<{ threadId: string; orderKey: number; x: number } | null>(null);
  const [nodeHeight, setNodeHeight] = useState(TIMELINE_CONFIG.NODE_COMPACT_HEIGHT);
  const [needsScroll, setNeedsScroll] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ nodeId: string; threadId: string } | null>(null);
  
  // 节点边缘 hover 状态
  const [hoveredEdge, setHoveredEdge] = useState<{ nodeId: string; edge: 'left' | 'right' } | null>(null);
  
  // 节点持续时长（以 grid 单位计）- 使用 Map 存储每个节点的 duration
  const [nodeDurations, setNodeDurations] = useState<Map<string, number>>(new Map());
  
  // 调整大小的状态
  const [resizingNode, setResizingNode] = useState<{
    nodeId: string;
    threadId: string;
    edge: 'left' | 'right';
    startX: number;
    startOrderKey: number;
    startDuration: number;
  } | null>(null);
  
  const timelineRef = useRef<HTMLDivElement>(null);
  
  // 获取节点宽度（像素）
  const getNodeWidth = (nodeId: string): number => {
    const duration = nodeDurations.get(nodeId) || TIMELINE_CONFIG.NODE_DEFAULT_DURATION;
    return duration * TIMELINE_CONFIG.GRID_UNIT;
  };

  // 计算最大 order_key
  const maxOrderKey = Math.max(...nodesWithThreads.map(n => n.orderKey), 0);
  const timelineWidth = maxOrderKey * TIMELINE_CONFIG.GRID_UNIT + TIMELINE_CONFIG.TIMELINE_PADDING * 2;

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
        await nodeUsecases.loadNodes({ type: 'chapter' });
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
        const chapters = bookNodes.filter((n) => n.type === 'chapter');
        const nodesWithThreadInfo = await Promise.all(
          chapters.map(async (node) => {
            const nodeThreads = await threadUsecases.getThreadsByNode(node.id);
            return { ...node, threads: nodeThreads };
          })
        );
        setNodesWithThreads(nodesWithThreadInfo);
      } catch (error) {
        console.error('Failed to load timeline data:', error);
      }
    }
    
    if (bookNodes.length > 0) {
      loadData();
    }
  }, [bookNodes, threadUsecases]);

  // 将 order_key 转换为像素位置
  const orderKeyToPosition = (orderKey: number) => {
    return TIMELINE_CONFIG.TIMELINE_PADDING + (orderKey - 1) * TIMELINE_CONFIG.GRID_UNIT;
  };

  // Handle drag start
  const handleDragStart = (e: React.DragEvent, node: TimelineNode, threadId: string) => {
    setDraggedNode({ node, threadId });
    e.dataTransfer.effectAllowed = 'move';
  };

  // Handle drag over - 计算应该放在哪个 orderKey 位置
  const handleDragOver = (e: React.DragEvent, threadId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    if (!timelineRef.current || !draggedNode) return;
    
    const rect = timelineRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left; // 鼠标相对于 timeline 的位置
    
    // 从鼠标位置（节点中心）反推节点左边缘的位置
    const nodeWidth = getNodeWidth(draggedNode.node.id);
    const nodeLeftX = mouseX - nodeWidth / 2;
    const relativeX = nodeLeftX - TIMELINE_CONFIG.TIMELINE_PADDING;
    const orderKey = Math.max(1, Math.round(relativeX / TIMELINE_CONFIG.GRID_UNIT) + 1);
    
    setDragOverPosition({ threadId, orderKey, x: mouseX });
  };

  // Handle drop
  const handleDrop = async (e: React.DragEvent, targetThreadId: string) => {
    e.preventDefault();
    if (!draggedNode || !dragOverPosition) return;

    const { node, threadId: sourceThreadId } = draggedNode;
    const targetOrderKey = dragOverPosition.orderKey;
    
    try {
      // If dropped in a different thread, update threads
      if (sourceThreadId !== targetThreadId) {
        // 添加到新 thread
        await threadUsecases.addNodeToThread(node.id, targetThreadId);
        
        // 移除旧 thread 的关联（不再特殊对待 main thread）
        await threadUsecases.removeNodeFromThread(node.id, sourceThreadId);
      }

      // Update order_key if changed
      if (targetOrderKey !== node.orderKey) {
        await nodeUsecases.updateNode(node.id, { orderKey: targetOrderKey });
      }

      // Reload data
      await nodeUsecases.loadNodes({ type: 'chapter' });
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
    
    const duration = nodeDurations.get(nodeId) || TIMELINE_CONFIG.NODE_DEFAULT_DURATION;
    
    setResizingNode({
      nodeId,
      threadId,
      edge,
      startX: e.clientX,
      startOrderKey: node.orderKey,
      startDuration: duration,
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
        // 调整右侧 - 改变 duration
        const newDuration = Math.max(1, resizingNode.startDuration + deltaGridUnits);
        setNodeDurations((prev) => {
          const next = new Map(prev);
          next.set(resizingNode.nodeId, newDuration);
          return next;
        });
      } else {
        // 调整左侧 - 改变 orderKey 和 duration
        const newOrderKey = Math.max(1, resizingNode.startOrderKey + deltaGridUnits);
        const newDuration = Math.max(1, resizingNode.startDuration - deltaGridUnits);
        
        // 临时更新 duration（视觉反馈）
        setNodeDurations((prev) => {
          const next = new Map(prev);
          next.set(resizingNode.nodeId, newDuration);
          return next;
        });
        
        // 临时更新节点位置（不写数据库，只在内存中）
        setNodesWithThreads((prev) => 
          prev.map((n) => 
            n.id === resizingNode.nodeId ? { ...n, orderKey: newOrderKey } : n
          )
        );
      }
    };
    
    const handleResizeEnd = async () => {
      if (resizingNode) {
        // 调整结束后才写入数据库
        const node = nodesWithThreads.find((n) => n.id === resizingNode.nodeId);
        if (node && node.orderKey !== resizingNode.startOrderKey) {
          await nodeUsecases.updateNode(resizingNode.nodeId, { orderKey: node.orderKey });
        }
        
        // 重新加载数据确保同步
        await nodeUsecases.loadNodes({ type: 'chapter' });
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
  }, [resizingNode, nodeUsecases, nodesWithThreads]);

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
          await nodeUsecases.deleteNode(nodeId);
          
          // 清除选中状态
          if (selectedNodeId === nodeId) {
            useAppStore.getState().setSelectedNodeId(null);
          }
          
          setShowDeleteConfirm(null);
        } catch (error) {
          console.error('Failed to delete node:', error);
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
      const chapters = bookNodes.filter((n) => n.type === 'chapter');
      const nodesWithThreadInfo = await Promise.all(
        chapters.map(async (node) => {
          const nodeThreads = await threadUsecases.getThreadsByNode(node.id);
          return { ...node, threads: nodeThreads };
        })
      );
      setNodesWithThreads(nodesWithThreadInfo);
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
      const chapters = bookNodes.filter((n) => n.type === 'chapter');
      const nodesWithThreadInfo = await Promise.all(
        chapters.map(async (node) => {
          const nodeThreads = await threadUsecases.getThreadsByNode(node.id);
          return { ...node, threads: nodeThreads };
        })
      );
      setNodesWithThreads(nodesWithThreadInfo);
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
    
    const leftPosition = orderKeyToPosition(node.orderKey);
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
          background: thread?.color || '#3B82F6',
          borderRadius: 6,
          padding: showText ? (isExpanded ? '8px 10px' : '4px 8px') : 0,
          display: 'flex',
          flexDirection: 'column',
          gap: showText ? 4 : 0,
          cursor: edgeHover ? 'ew-resize' : 'grab',
          opacity: isDragging ? 0.5 : 1,
          // 拆分 border 为单独的属性以避免冲突
          borderTop: isSelected ? '2px solid #fff' : '2px solid transparent',
          borderBottom: isSelected ? '2px solid #fff' : '2px solid transparent',
          borderLeft: edgeHover === 'left' 
            ? '3px solid rgba(255, 255, 255, 0.8)' 
            : (isSelected ? '2px solid #fff' : '2px solid transparent'),
          borderRight: edgeHover === 'right' 
            ? '3px solid rgba(255, 255, 255, 0.8)' 
            : (isSelected ? '2px solid #fff' : '2px solid transparent'),
          boxShadow: isSelected ? '0 0 0 2px rgba(255, 255, 255, 0.3)' : 'none',
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
                color: '#fff',
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
                  color: 'rgba(255, 255, 255, 0.8)',
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
              background: isConfirmingDelete ? '#EF4444' : 'rgba(0, 0, 0, 0.8)',
              border: '2px solid #fff',
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
    const headerHeight = isExpanded ? 20 : 0;
    const rowHeight = nodeHeight + TIMELINE_CONFIG.THREAD_PADDING * 2 + headerHeight;
    
    // 检查选中的节点是否属于当前 thread
    const selectedNode = nodesWithThreads.find((n) => n.id === selectedNodeId);
    const selectedNodeBelongsToThread = selectedNode?.threads.some((t) => t.id === thread.id);
    
    // 计算选中节点的有效添加区域
    const selectedNodeLeft = selectedNode ? orderKeyToPosition(selectedNode.orderKey) : 0;
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
          
          setHoveredPosition({ threadId: thread.id, orderKey: selectedNode?.orderKey || 1, x });
        }}
        onMouseLeave={() => {
          setHoveredPosition(null);
        }}
        style={{
          position: 'relative',
          height: rowHeight,
          marginBottom: TIMELINE_CONFIG.THREAD_GAP,
          paddingLeft: TIMELINE_CONFIG.TIMELINE_PADDING,
        }}
      >
        {/* Thread label */}
        {isExpanded && (
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: thread.color,
              marginBottom: 6,
              height: headerHeight,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {thread.name}
          </div>
        )}

        {/* Node container with absolute positioning */}
        <div
          data-node-container
          style={{
            position: 'relative',
            width: '100%',
            height: nodeHeight,
            background: 'rgba(255, 255, 255, 0.02)',
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
                background: '#fff',
                opacity: 0.5,
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
                left: orderKeyToPosition(selectedNode.orderKey) + getNodeWidth(selectedNode.id) / 2,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: 'rgba(34, 197, 94, 0.9)',
                border: '2px solid #fff',
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
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
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
                color: 'rgba(255, 255, 255, 0.3)',
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
        background: 'linear-gradient(to top, rgba(45, 36, 56, 0.98), rgba(45, 36, 56, 0.95))',
        borderTop: '1px solid rgba(255, 255, 255, 0.1)',
        transition: 'height 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
        zIndex: 20,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        padding: isExpanded ? '16px 0' : '12px 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflowX: 'auto',
          overflowY: isExpanded && needsScroll ? 'auto' : 'hidden',
          paddingRight: 12,
        }}
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
              color: 'rgba(255, 255, 255, 0.5)',
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
