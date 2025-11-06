import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store';
import { useStoryThreadUsecases } from '../hooks/useStoryThreadUsecases';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import { createBookContentRepository } from '../repositories/book_content_sqlite';
import { parseOutline } from '../lib/outline';
import type { OutlineItem } from '../schema/book_content';
import type { StoryThread } from '../domain/story_thread';
import type { BookNode } from '../domain/book_node';

const PROJECT_ID = 'default-project';

// Timeline 配置
const TIMELINE_CONFIG = {
  GRID_UNIT: 20, // 每个网格单位占用的像素宽度（从40改为20，提高精度）
  NODE_MIN_WIDTH: 40, // 节点最小宽度（2个网格单位）
  NODE_DEFAULT_WIDTH: 4, // 节点默认宽度（4个网格单位 = 80px）
  NODE_MIN_HEIGHT: 18, // 节点最小高度 - 隐藏时只显示标题
  NODE_EXPANDED_HEIGHT: 60, // 展开时节点理想高度
  NODE_COMPACT_HEIGHT: 6, // 收起时节点高度 - 极简模式，更扁（从8改为6）
  THREAD_PADDING: 4, // 每个 thread 行的上下内边距（展开时）
  THREAD_PADDING_COMPACT: 0, // 每个 thread 行的上下内边距（收起时，无内边距）
  THREAD_GAP: 2, // thread 之间的间隔（展开时）
  THREAD_GAP_COMPACT: 0, // thread 之间的间隔（收起时，无间隔）
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
  const contentRepo = useRef(createBookContentRepository()).current;
  
  const [threads, setThreads] = useState<StoryThread[]>([]);
  const [nodesWithThreads, setNodesWithThreads] = useState<TimelineNode[]>([]);
  const [nodeOutlines, setNodeOutlines] = useState<Map<string, OutlineItem[]>>(new Map());
  const [isExpanded, setIsExpanded] = useState(false);
  const [isPinned, setIsPinned] = useState(false); // 是否固定展开状态
  const [isTransitioning, setIsTransitioning] = useState(false); // 动画过渡状态
  const [mouseEnterX, setMouseEnterX] = useState(0); // 记录鼠标进入时的 X 坐标
  const [draggedNode, setDraggedNode] = useState<{ node: TimelineNode; threadId: string } | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<{ threadId: string; start: number; x: number } | null>(null);
  const [nodeHeight, setNodeHeight] = useState(TIMELINE_CONFIG.NODE_COMPACT_HEIGHT);
  const [needsScroll, setNeedsScroll] = useState(false);
  
  // Context Menu 状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: 'thread-empty' | 'node' | 'thread-with-selected';
    threadId?: string;
    nodeId?: string;
    position?: number;
    // Node 预览信息
    nodeTitle?: string;
    nodeSummary?: string | null;
    nodeThreads?: StoryThread[];
  } | null>(null);
  
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
  const contextMenuRef = useRef<HTMLDivElement>(null);
  
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
  // 获取节点宽度（像素）- 考虑缩放
  const getNodeWidth = (nodeId: string): number => {
    const node = nodesWithThreads.find(n => n.id === nodeId);
    if (!node) return TIMELINE_CONFIG.NODE_DEFAULT_WIDTH * TIMELINE_CONFIG.GRID_UNIT * scaleFactor;
    
    const end = nodeEnds.get(nodeId) ?? node.end;
    if (end === null || end === undefined) {
      return TIMELINE_CONFIG.NODE_DEFAULT_WIDTH * TIMELINE_CONFIG.GRID_UNIT * scaleFactor;
    }
    
    const width = (end - node.start) * TIMELINE_CONFIG.GRID_UNIT * scaleFactor;
    return Math.max(width, TIMELINE_CONFIG.NODE_MIN_WIDTH);
  };

  // 计算 timeline 范围
  // 收起时和展开时都显示所有节点，但收起时会通过缩放来适应窗口
  const minStart = nodesWithThreads.length > 0 ? Math.min(...nodesWithThreads.map(n => n.start)) : 0;
  const maxEnd = nodesWithThreads.length > 0 
    ? Math.max(...nodesWithThreads.map(n => n.end ?? (n.start + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH))) 
    : 0;
  
  // 收起时：计算缩放比例，让所有节点适应窗口宽度
  // 展开时：不缩放，使用正常的 GRID_UNIT
  const timelineRange = maxEnd - minStart;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const availableWidth = viewportWidth - 40; // 减去左右边距
  
  const scaleFactor = isExpanded 
    ? 1 
    : Math.min(1, availableWidth / (timelineRange * TIMELINE_CONFIG.GRID_UNIT));
  
  // 展开时：添加 25% 视口宽度的额外空间用于扩展新 node
  // 收起时：只添加 40px 基础边距
  const extraSpace = isExpanded ? (viewportWidth * 0.25) : 40;
  const timelineWidth = timelineRange * TIMELINE_CONFIG.GRID_UNIT * scaleFactor + extraSpace;

  // 计算 timeline 的总高度
  const getTimelineHeight = () => {
    if (threads.length === 0) return 120;
    
    if (isExpanded) {
      // 展开时：使用正常的 padding 和 gap
      const rowHeight = nodeHeight + TIMELINE_CONFIG.THREAD_PADDING * 2;
      const totalThreadsHeight = rowHeight * threads.length + TIMELINE_CONFIG.THREAD_GAP * (threads.length - 1);
      const padding = 32; // 上下 padding
      return Math.max(280, totalThreadsHeight + padding);
    } else {
      // 隐藏时：最小化 padding 和 gap，无上下 padding
      const rowHeight = nodeHeight + TIMELINE_CONFIG.THREAD_PADDING_COMPACT * 2;
      const totalThreadsHeight = rowHeight * threads.length + TIMELINE_CONFIG.THREAD_GAP_COMPACT * (threads.length - 1);
      return totalThreadsHeight; // 完全去掉额外 padding
    }
  };

  // 动态设置节点高度，带 fade 动画
  useEffect(() => {
    if (isExpanded) {
      // 展开动画序列
      setIsTransitioning(true);
      
      // 1. 先 fade out (150ms)
      setTimeout(() => {
        // 2. 改变高度和布局
        setNodeHeight(TIMELINE_CONFIG.NODE_EXPANDED_HEIGHT);
        
        // 3. fade in (150ms)
        setTimeout(() => {
          setIsTransitioning(false);
          setNeedsScroll(false);
        }, 150);
      }, 150);
    } else {
      // 收起动画序列
      setIsTransitioning(true);
      
      // 1. 先 fade out (150ms)
      setTimeout(() => {
        // 2. 改变高度和布局
        setNodeHeight(TIMELINE_CONFIG.NODE_COMPACT_HEIGHT);
        
        // 3. fade in (150ms)
        setTimeout(() => {
          setIsTransitioning(false);
          setNeedsScroll(false);
        }, 150);
      }, 150);
    }
  }, [isExpanded]);
  
  // 更新全局 timeline 高度
  useEffect(() => {
    const height = getTimelineHeight();
    useAppStore.getState().setTimelineHeight(height);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded, threads.length, nodeHeight]);

  // 处理展开时的滚动位置调整 - 以鼠标位置为中心展开
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isExpanded || mouseEnterX === 0) return;
    
    // 使用 requestAnimationFrame 确保在 DOM 更新后执行
    requestAnimationFrame(() => {
      if (!container) return;
      
      // Thread 标签的宽度（仅展开时存在）
      const THREAD_LABEL_WIDTH = 68; // 60px width + 8px paddingRight
      
      // 计算鼠标在收起状态下对应的时间轴位置（考虑收起时的缩放）
      // mouseEnterX 是相对于视口的，需要转换为相对于容器的位置
      const containerRect = container.getBoundingClientRect();
      const mouseXInContainer = mouseEnterX - containerRect.left;
      
      // 收起时的缩放因子（这里需要重新计算，因为 scaleFactor 已经变成 1 了）
      const timelineRange = maxEnd - minStart;
      const availableWidth = typeof window !== 'undefined' ? window.innerWidth - 40 : 1200;
      const collapsedScaleFactor = Math.min(1, availableWidth / (timelineRange * TIMELINE_CONFIG.GRID_UNIT));
      
      // 鼠标位置对应的时间轴坐标（start 值）
      // 收起时没有 thread 标签，所以直接使用 mouseXInContainer
      const startAtMouse = minStart + (mouseXInContainer / (TIMELINE_CONFIG.GRID_UNIT * collapsedScaleFactor));
      
      // 展开后，该 start 值对应的像素位置（需要加上 thread 标签宽度）
      const expandedPositionAtMouse = (startAtMouse - minStart) * TIMELINE_CONFIG.GRID_UNIT + THREAD_LABEL_WIDTH;
      
      // 调整滚动位置，使得该位置保持在鼠标下方
      container.scrollLeft = expandedPositionAtMouse - mouseXInContainer;
    });
  }, [isExpanded, mouseEnterX, minStart, maxEnd]);

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

  // Load outlines for all nodes
  useEffect(() => {
    async function loadOutlines() {
      try {
        const outlinesMap = new Map<string, OutlineItem[]>();
        
        for (const node of nodesWithThreads) {
          const content = await contentRepo.findByNodeId(node.id);
          if (content && content.outlineJson) {
            try {
              const outline = parseOutline(content.outlineJson);
              outlinesMap.set(node.id, outline);
            } catch (error) {
              console.error(`Failed to parse outline for node ${node.id}:`, error);
            }
          }
        }
        
        setNodeOutlines(outlinesMap);
      } catch (error) {
        console.error('Failed to load outlines:', error);
      }
    }
    
    if (nodesWithThreads.length > 0) {
      loadOutlines();
    }
  }, [nodesWithThreads, contentRepo]);

  // 计算 Context Menu 的位置，防止溢出视口
  const getContextMenuPosition = (x: number, y: number, menuWidth: number, menuHeight: number) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 8; // 距离视口边缘的最小距离
    
    let adjustedX = x;
    let adjustedY = y;
    
    // 检查右侧溢出
    if (x + menuWidth + padding > viewportWidth) {
      adjustedX = Math.max(padding, x - menuWidth);
    }
    
    // 检查底部溢出
    if (y + menuHeight + padding > viewportHeight) {
      adjustedY = Math.max(padding, viewportHeight - menuHeight - padding);
    }
    
    // 检查左侧溢出
    if (adjustedX < padding) {
      adjustedX = padding;
    }
    
    // 检查顶部溢出
    if (adjustedY < padding) {
      adjustedY = padding;
    }
    
    return { x: adjustedX, y: adjustedY };
  };

  // Context Menu 处理函数
  const handleContextMenuAction = async (action: string) => {
    if (!contextMenu) return;
    
    // 保存滚动位置（除了导航类操作）
    const scrollContainer = scrollContainerRef.current;
    const savedScrollLeft = scrollContainer?.scrollLeft || 0;
    const shouldRestoreScroll = !['editChapter'].includes(action);
    
    try {
      switch (action) {
        case 'createChapter':
          if (contextMenu.type === 'thread-empty' && contextMenu.threadId && contextMenu.position) {
            // 创建新章节
            const newNode = await nodeUsecases.createNode({
              title: 'New Chapter',
              start: contextMenu.position,
              end: contextMenu.position + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH,
            });
            
            // 将 node 添加到用户指定的 thread
            // 因为这是第一个 thread，thread_order=0，它将成为此 node 的 primary thread
            await threadUsecases.addNodeToThread(newNode.id, contextMenu.threadId);
            
            // 设置为选中状态并导航
            useAppStore.getState().setSelectedNodeId(newNode.id);
            navigate(`/editor/${newNode.id}`);
            // 重新加载数据
            await nodeUsecases.loadNodes();
          }
          break;
          
        case 'editChapter':
          if (contextMenu.type === 'node' && contextMenu.nodeId) {
            // 导航到编辑器
            useAppStore.getState().setSelectedNodeId(contextMenu.nodeId);
            navigate(`/editor/${contextMenu.nodeId}`);
          }
          break;
          
        case 'removeFromThread':
          if (contextMenu.type === 'node' && contextMenu.nodeId && contextMenu.threadId) {
            // 获取当前 node 的所有 threads
            const nodeThreads = await threadUsecases.getThreadsByNode(contextMenu.nodeId);
            
            // 如果这是唯一的 thread，删除整个 node
            if (nodeThreads.length === 1) {
              await nodeUsecases.deleteNode(contextMenu.nodeId);
              // 如果删除的是当前选中的节点，清除选中并导航
              if (selectedNodeId === contextMenu.nodeId) {
                useAppStore.getState().setSelectedNodeId(null);
                navigate('/editor');
              }
            } else {
              // 检查是否删除的是主 thread（第一个 thread）
              const isRemovingPrimaryThread = nodeThreads.length > 0 && nodeThreads[0].id === contextMenu.threadId;
              
              if (isRemovingPrimaryThread) {
                // 如果删除主 thread 且还有其他 threads，将剩余的 threads 重新排序
                const remainingThreadIds = nodeThreads
                  .filter(t => t.id !== contextMenu.threadId)
                  .map(t => t.id);
                
                // 第一个剩余的 thread 会成为新的主 thread
                await threadUsecases.setNodeThreads(contextMenu.nodeId, remainingThreadIds);
              } else {
                // 如果不是主 thread，直接删除
                await threadUsecases.removeNodeFromThread(contextMenu.nodeId, contextMenu.threadId);
              }
            }
            
            // 重新加载数据
            await nodeUsecases.loadNodes();
            // 恢复滚动
            if (shouldRestoreScroll && scrollContainer) {
              requestAnimationFrame(() => {
                scrollContainer.scrollLeft = savedScrollLeft;
              });
            }
          }
          break;
          
        case 'deleteNode':
          if (contextMenu.type === 'node' && contextMenu.nodeId) {
            // 删除整个节点
            await nodeUsecases.deleteNode(contextMenu.nodeId);
            // 如果删除的是当前选中的节点，清除选中并导航
            if (selectedNodeId === contextMenu.nodeId) {
              useAppStore.getState().setSelectedNodeId(null);
              navigate('/editor');
            }
            // 重新加载数据
            await nodeUsecases.loadNodes();
            // 恢复滚动
            if (shouldRestoreScroll && scrollContainer) {
              requestAnimationFrame(() => {
                scrollContainer.scrollLeft = savedScrollLeft;
              });
            }
          }
          break;
          
        case 'addToThread':
          if (contextMenu.type === 'thread-with-selected' && contextMenu.threadId && selectedNodeId) {
            // 添加选中的节点到此 thread
            await threadUsecases.addNodeToThread(selectedNodeId, contextMenu.threadId);
            // 重新加载数据
            await nodeUsecases.loadNodes();
            // 恢复滚动
            if (shouldRestoreScroll && scrollContainer) {
              requestAnimationFrame(() => {
                scrollContainer.scrollLeft = savedScrollLeft;
              });
            }
          }
          break;
      }
    } catch (error) {
      console.error('Context menu action failed:', error);
    } finally {
      setContextMenu(null);
    }
  };
  
  // 点击其他地方关闭 context menu
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    
    if (contextMenu) {
      document.addEventListener('click', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
      return () => {
        document.removeEventListener('click', handleClickOutside);
        document.removeEventListener('keydown', handleEscape);
      };
    }
  }, [contextMenu]);

  // 将 start 转换为像素位置（考虑 minStart 偏移和缩放）
  const startToPosition = (start: number) => {
    return (start - minStart) * TIMELINE_CONFIG.GRID_UNIT * scaleFactor;
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
    // 考虑缩放和偏移：将像素位置转换回 start 值
    const start = Math.max(minStart, Math.round(nodeLeftX / (TIMELINE_CONFIG.GRID_UNIT * scaleFactor)) + minStart);
    
    setDragOverPosition({ threadId, start, x: mouseX });
  };

  // Handle drop
  const handleDrop = async (e: React.DragEvent, targetThreadId: string) => {
    e.preventDefault();
    if (!draggedNode || !dragOverPosition) return;

    const { node, threadId: sourceThreadId } = draggedNode;
    const targetStart = dragOverPosition.start;
    
    try {
      // Check if this is a primary thread (first thread in node.threads)
      const isPrimaryThread = node.threads.length > 0 && node.threads[0].id === sourceThreadId;
      const isTargetInNodeThreads = node.threads.some(t => t.id === targetThreadId);
      
      // Only allow dragging from primary thread
      if (!isPrimaryThread) {
        console.warn('Can only drag from primary thread');
        return;
      }
      
      // If dropped in a different thread
      if (sourceThreadId !== targetThreadId) {
        if (isTargetInNodeThreads) {
          // Target thread already belongs to this node
          // Keep source thread, but make target thread the new primary
          const newThreadOrder = [
            targetThreadId,
            ...node.threads.filter(t => t.id !== targetThreadId).map(t => t.id)
          ];
          await threadUsecases.setNodeThreads(node.id, newThreadOrder);
        } else {
          // Target thread is new to this node
          // Remove old primary thread and add target as new primary
          await threadUsecases.removeNodeFromThread(node.id, sourceThreadId);
          
          // Add target thread as the first (primary) thread
          const remainingThreadIds = node.threads
            .filter(t => t.id !== sourceThreadId)
            .map(t => t.id);
          await threadUsecases.setNodeThreads(node.id, [targetThreadId, ...remainingThreadIds]);
        }
      }

      // Update start position if changed (and maintain position regardless of thread changes)
      if (targetStart !== node.start) {
        // Calculate new end to maintain width
        const currentEnd = nodeEnds.get(node.id) ?? node.end;
        const width = currentEnd !== null ? currentEnd - node.start : TIMELINE_CONFIG.NODE_DEFAULT_WIDTH;
        const newEnd = targetStart + width;
        
        await nodeUsecases.updateNode(node.id, { start: targetStart, end: newEnd });
      }

      // Reload data - 不恢复滚动位置，让浏览器保持自然状态
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
        
        // 保存滚动位置
        const scrollContainer = scrollContainerRef.current;
        const savedScrollLeft = scrollContainer?.scrollLeft || 0;
        
        // 重新加载数据确保同步
        await nodeUsecases.loadNodes();
        
        // 恢复滚动位置
        if (scrollContainer) {
          requestAnimationFrame(() => {
            scrollContainer.scrollLeft = savedScrollLeft;
          });
        }
        
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

  // 判断一个 node 是否应该在当前 thread 上作为"主显示"
  // 规则：在 node 的第一个 thread 上完整显示，其他 threads 上显示连接点
  const isPrimaryThreadForNode = (node: TimelineNode, threadId: string): boolean => {
    if (node.threads.length === 0) return false;
    return node.threads[0].id === threadId;
  };

  // 渲染连接线和标记点（用于跨多个 threads 的 node）
  const renderNodeConnections = (node: TimelineNode, currentThreadIndex: number) => {
    // 只有当 node 在多个 threads 中时才渲染连接
    if (node.threads.length <= 1) return null;
    
    // 找到主 thread 的索引（第一个 thread）
    const primaryThreadId = node.threads[0].id;
    const primaryThreadIndex = threads.findIndex(t => t.id === primaryThreadId);
    
    if (primaryThreadIndex === -1) return null;
    
    // 计算连接线的位置
    const rowHeight = nodeHeight + (isExpanded ? TIMELINE_CONFIG.THREAD_PADDING : TIMELINE_CONFIG.THREAD_PADDING_COMPACT) * 2;
    const rowGap = isExpanded ? TIMELINE_CONFIG.THREAD_GAP : TIMELINE_CONFIG.THREAD_GAP_COMPACT;
    
    // 收集需要绘制连接线的所有 thread 索引
    const connectionLines: React.ReactElement[] = [];
    
    node.threads.forEach((thread, idx) => {
      if (idx === 0) return; // 跳过主 thread（第一个）
      
      const targetThreadIndex = threads.findIndex(t => t.id === thread.id);
      if (targetThreadIndex === -1) return;
      
      // 只在主 thread 上绘制所有连接线
      if (currentThreadIndex === primaryThreadIndex) {
        const verticalDistance = Math.abs(targetThreadIndex - primaryThreadIndex) * (rowHeight + rowGap);
        const isBelow = targetThreadIndex > primaryThreadIndex;
        
        connectionLines.push(
          <div
            key={`connection-${thread.id}`}
            style={{
              position: 'absolute',
              left: '50%',
              transform: 'translateX(-50%)',
              top: isBelow ? nodeHeight : -verticalDistance,
              width: isExpanded ? 2 : 1,
              height: verticalDistance,
              background: threads.find(t => t.id === primaryThreadId)?.color || '#b89968',
              opacity: isExpanded ? 0.5 : 0.3,
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
        );
      }
    });
    
    return <>{connectionLines}</>;
  };

  // Render a single node card
  const renderNodeCard = (node: TimelineNode, threadId: string) => {
    const thread = threads.find((t) => t.id === threadId);
    const isDragging = draggedNode?.node.id === node.id;
    const isSelected = selectedNodeId === node.id;
    const isPrimary = isPrimaryThreadForNode(node, threadId);
    const currentThreadIndex = threads.findIndex(t => t.id === threadId);
    
    // startToPosition 已经处理了 minStart 偏移和缩放
    const leftPosition = startToPosition(node.start);
    const nodeWidth = getNodeWidth(node.id);
    
    // 如果不是主 thread，显示标记点而不是完整 node
    if (!isPrimary && node.threads.length > 1) {
      const markerSize = isExpanded ? 12 : 6;
      return (
        <div
          key={`${node.id}-${threadId}-marker`}
          onClick={(e) => handleNodeClick(node.id, e)}
          style={{
            position: 'absolute',
            left: leftPosition + nodeWidth / 2 - markerSize / 2,
            top: nodeHeight / 2 - markerSize / 2,
            width: markerSize,
            height: markerSize,
            borderRadius: '50%',
            background: thread?.color || '#b89968',
            border: isExpanded ? `2px solid ${thread?.color || '#b89968'}` : 'none',
            boxShadow: isSelected 
              ? `0 0 0 ${isExpanded ? 3 : 2}px rgba(255, 255, 255, 0.8), 0 0 0 ${isExpanded ? 5 : 3}px ${thread?.color || '#b89968'}`
              : isExpanded ? `0 2px 4px ${thread?.color}60` : 'none',
            cursor: 'pointer',
            opacity: isSelected ? 1 : (isExpanded ? 0.9 : 0.7),
            transition: 'all 0.2s',
            zIndex: isSelected ? 10 : 5,
          }}
          title={isExpanded ? `${node.title} (from ${node.threads[0]?.name || 'another thread'})` : undefined}
        />
      );
    }
    
    // 主 thread 上显示完整 node
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
        draggable={!edgeHover && isPrimary}
        onDragStart={(e) => handleDragStart(e, node, threadId)}
        onDragEnd={handleDragEnd}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
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
          background: isExpanded ? '#fefdfb' : (thread?.color || '#b89968'), // 收起时用 thread 颜色填充
          borderRadius: isExpanded ? 6 : 3, // 收起时更小的圆角
          cursor: edgeHover ? 'ew-resize' : (isPrimary ? 'grab' : 'default'),
          opacity: isTransitioning ? 0 : (isDragging ? 0.5 : (isExpanded ? 1 : (isSelected ? 1 : 0.8))), // 过渡时透明，收起时未选中的节点略微透明
          // 展开时使用边框，收起时无边框（因为已经是实色填充）
          borderTop: isExpanded ? (isSelected ? `2px solid ${thread?.color || '#b89968'}` : `1px solid ${thread?.color || '#b89968'}`) : 'none',
          borderBottom: isExpanded ? (isSelected ? `2px solid ${thread?.color || '#b89968'}` : `1px solid ${thread?.color || '#b89968'}`) : 'none',
          borderLeft: isExpanded ? (edgeHover === 'left' 
            ? `3px solid ${thread?.color || '#b89968'}` 
            : (isSelected ? `2px solid ${thread?.color || '#b89968'}` : `1px solid ${thread?.color || '#b89968'}`)) : 'none',
          borderRight: isExpanded ? (edgeHover === 'right' 
            ? `3px solid ${thread?.color || '#b89968'}` 
            : (isSelected ? `2px solid ${thread?.color || '#b89968'}` : `1px solid ${thread?.color || '#b89968'}`)) : 'none',
          boxShadow: isExpanded 
            ? (isSelected ? `0 2px 8px ${thread?.color || '#b89968'}40` : '0 1px 4px rgba(90, 74, 58, 0.1)') 
            : (isSelected ? `0 0 0 2px rgba(255, 255, 255, 0.8), 0 0 0 3px ${thread?.color || '#b89968'}` : 'none'), // 收起时选中节点用外发光高亮
          transition: 'opacity 0.2s ease-in-out, box-shadow 0.2s',
          overflow: 'visible',
        }}
      >
        {/* 连接线 - 如果node在多个threads中 */}
        {node.threads.length > 1 && renderNodeConnections(node, currentThreadIndex)}
        
        {/* Outline 刻度线背景层 - 仅展开时显示 */}
        {isExpanded && (() => {
          const outline = nodeOutlines.get(node.id);
          if (!outline || outline.length === 0) return null;

          // 计算刻度线的位置分布
          const calculateRulerPositions = () => {
            const h1Items = outline.filter(item => item.level === 1);
            const h2Items = outline.filter(item => item.level === 2);
            const h3Items = outline.filter(item => item.level === 3);

            if (isExpanded) {
              // 展开状态：显示所有层级，均匀分布
              const positions: { left: string; level: number }[] = [];

              // H1 均分整个宽度
              h1Items.forEach((h1, index) => {
                const position = ((index + 0.5) / h1Items.length) * 100;
                positions.push({ left: `${position}%`, level: 1 });

                // 计算当前 H1 的范围边界
                const h1Pos = outline.indexOf(h1);
                const nextH1Pos = index < h1Items.length - 1 
                  ? outline.indexOf(h1Items[index + 1]) 
                  : outline.length;

                // H2 在对应 H1 的区间内均分
                const h2InThisH1 = h2Items.filter(h2 => {
                  const h2Pos = outline.indexOf(h2);
                  return h2Pos > h1Pos && h2Pos < nextH1Pos;
                });

                if (h2InThisH1.length > 0) {
                  const h1Start = (index / h1Items.length) * 100;
                  const h1End = ((index + 1) / h1Items.length) * 100;
                  
                  h2InThisH1.forEach((h2, h2Index) => {
                    const h2Position = h1Start + ((h2Index + 0.5) / h2InThisH1.length) * (h1End - h1Start);
                    positions.push({ left: `${h2Position}%`, level: 2 });

                    // 计算当前 H2 的范围边界
                    const h2Pos = outline.indexOf(h2);
                    const nextH2Pos = h2Index < h2InThisH1.length - 1
                      ? outline.indexOf(h2InThisH1[h2Index + 1])
                      : nextH1Pos;

                    // H3 在对应 H2 的区间内均分
                    const h3InThisH2 = h3Items.filter(h3 => {
                      const h3Pos = outline.indexOf(h3);
                      return h3Pos > h2Pos && h3Pos < nextH2Pos;
                    });

                    if (h3InThisH2.length > 0) {
                      const h2Start = h1Start + (h2Index / h2InThisH1.length) * (h1End - h1Start);
                      const h2End = h1Start + ((h2Index + 1) / h2InThisH1.length) * (h1End - h1Start);
                      
                      h3InThisH2.forEach((_, h3Index) => {
                        const h3Position = h2Start + ((h3Index + 0.5) / h3InThisH2.length) * (h2End - h2Start);
                        positions.push({ left: `${h3Position}%`, level: 3 });
                      });
                    }
                  });
                }
              });

              return positions;
            } else {
              // 收起状态：显示所有层级，均匀分布（和展开时相同）
              const positions: { left: string; level: number }[] = [];

              // H1 均分整个宽度
              h1Items.forEach((h1, index) => {
                const position = ((index + 0.5) / h1Items.length) * 100;
                positions.push({ left: `${position}%`, level: 1 });

                // 计算当前 H1 的范围边界
                const h1Pos = outline.indexOf(h1);
                const nextH1Pos = index < h1Items.length - 1 
                  ? outline.indexOf(h1Items[index + 1]) 
                  : outline.length;

                // H2 在对应 H1 的区间内均分
                const h2InThisH1 = h2Items.filter(h2 => {
                  const h2Pos = outline.indexOf(h2);
                  return h2Pos > h1Pos && h2Pos < nextH1Pos;
                });

                if (h2InThisH1.length > 0) {
                  const h1Start = (index / h1Items.length) * 100;
                  const h1End = ((index + 1) / h1Items.length) * 100;
                  
                  h2InThisH1.forEach((h2, h2Index) => {
                    const h2Position = h1Start + ((h2Index + 0.5) / h2InThisH1.length) * (h1End - h1Start);
                    positions.push({ left: `${h2Position}%`, level: 2 });

                    // 计算当前 H2 的范围边界
                    const h2Pos = outline.indexOf(h2);
                    const nextH2Pos = h2Index < h2InThisH1.length - 1
                      ? outline.indexOf(h2InThisH1[h2Index + 1])
                      : nextH1Pos;

                    // H3 在对应 H2 的区间内均分
                    const h3InThisH2 = h3Items.filter(h3 => {
                      const h3Pos = outline.indexOf(h3);
                      return h3Pos > h2Pos && h3Pos < nextH2Pos;
                    });

                    if (h3InThisH2.length > 0) {
                      const h2Start = h1Start + (h2Index / h2InThisH1.length) * (h1End - h1Start);
                      const h2End = h1Start + ((h2Index + 1) / h2InThisH1.length) * (h1End - h1Start);
                      
                      h3InThisH2.forEach((_, h3Index) => {
                        const h3Position = h2Start + ((h3Index + 0.5) / h3InThisH2.length) * (h2End - h2Start);
                        positions.push({ left: `${h3Position}%`, level: 3 });
                      });
                    }
                  });
                }
              });

              return positions;
            }
          };

          const rulerPositions = calculateRulerPositions();

          return (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: isExpanded ? 10 : '100%', // 展开时只占底部 10px，收起时占满
                pointerEvents: 'none', // 不阻挡点击事件
                zIndex: 0, // 作为背景层
              }}
            >
              {rulerPositions.map((pos, index) => (
                <div
                  key={index}
                  style={{
                    position: 'absolute',
                    left: pos.left,
                    transform: 'translateX(-50%)', // 居中对齐
                    bottom: 0,
                    width: isExpanded 
                      ? 1 // 展开时统一细线
                      : (pos.level === 1 ? 4 : pos.level === 2 ? 2 : 1), // 收起时根据层级区分宽度
                    height: isExpanded 
                      ? (pos.level === 1 ? 8 : pos.level === 2 ? 6 : 4) // 展开时不同高度
                      : '100%', // 收起时和 node 一样高
                    backgroundColor: isExpanded
                      ? (thread?.color || '#b89968') // 展开时用 thread 颜色
                      : 'rgba(0, 0, 0, 0.39)', // 收起时用半透明灰色
                    borderRadius: isExpanded ? 0.5 : 0,
                    opacity: isExpanded ? 0.5 : 1, // 收起时完全不透明
                  }}
                />
              ))}
            </div>
          );
        })()}
        
        {/* 内容前景层 - 仅展开时显示 */}
        {isExpanded && (
          <div style={{
            position: 'relative', // 相对定位，覆盖在刻度上方
            zIndex: 1, // 在刻度线之上
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 10px 12px 10px', // 底部留空给刻度线
            height: '100%',
            boxSizing: 'border-box',
          }}>
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
            
            {/* 摘要 */}
            {node.summary && (
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
          </div>
        )}
      </div>
    );
  };

  // Render a single thread row using absolute positioning
  const renderThreadRow = (thread: StoryThread) => {
    const nodesInThread = nodesWithThreads.filter((n) => n.threads.some((t) => t.id === thread.id));
    
    // 根据展开状态使用不同的 padding
    const threadPadding = isExpanded ? TIMELINE_CONFIG.THREAD_PADDING : TIMELINE_CONFIG.THREAD_PADDING_COMPACT;
    const rowHeight = nodeHeight + threadPadding * 2;
    
    // 检查选中的节点是否属于当前 thread
    const selectedNode = nodesWithThreads.find((n) => n.id === selectedNodeId);
    const selectedNodeBelongsToThread = selectedNode?.threads.some((t) => t.id === thread.id);

    return (
      <div
        key={thread.id}
        onDragOver={(e) => handleDragOver(e, thread.id)}
        onDrop={(e) => handleDrop(e, thread.id)}
        onClick={handleTimelineClick}
        onContextMenu={(e) => {
          e.preventDefault();
          const container = e.currentTarget.querySelector('[data-node-container]') as HTMLElement;
          if (!container) return;
          
          const rect = container.getBoundingClientRect();
          const x = e.clientX - rect.left;
          
          // 从像素位置转换为 start（timeline position）
          const position = Math.max(1, Math.round(x / TIMELINE_CONFIG.GRID_UNIT) + 1);
          
          // 检查是否点击在某个 node 上
          const clickedNode = nodesInThread.find(node => {
            const nodeLeft = startToPosition(node.start);
            const nodeRight = nodeLeft + getNodeWidth(node.id);
            return x >= nodeLeft && x <= nodeRight;
          });
          
          if (clickedNode) {
            // 点击在 node 上 - 添加预览信息
            // 从光标右上角展开（光标位置 + 小偏移）
            setContextMenu({
              x: e.clientX + 2,
              y: e.clientY - 2,
              type: 'node',
              nodeId: clickedNode.id,
              threadId: thread.id,
              nodeTitle: clickedNode.title,
              nodeSummary: clickedNode.summary,
              nodeThreads: clickedNode.threads,
            });
          } else if (selectedNodeId && !selectedNodeBelongsToThread) {
            // 选中了某个 node，且点击在空白处，可以添加 node 到此 thread
            setContextMenu({
              x: e.clientX + 2,
              y: e.clientY - 2,
              type: 'thread-with-selected',
              threadId: thread.id,
            });
          } else {
            // Thread 空白处，可以新增 chapter
            setContextMenu({
              x: e.clientX + 2,
              y: e.clientY - 2,
              type: 'thread-empty',
              threadId: thread.id,
              position,
            });
          }
        }}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          height: rowHeight,
          marginBottom: isExpanded ? TIMELINE_CONFIG.THREAD_GAP : TIMELINE_CONFIG.THREAD_GAP_COMPACT,
          gap: isExpanded ? 12 : 8, // 收起时减小 gap
        }}
      >
        {/* Thread label - 仅展开时显示 */}
        {isExpanded && (
          <div
            onClick={() => {
              useAppStore.getState().setSelectedNodeId(null);
              navigate(`/editor/thread/${thread.id}`);
            }}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'rgba(71, 71, 71, 0.85)',
              width: 60, // 固定宽度，确保所有 thread 对齐
              flexShrink: 0, // 防止被压缩
              textAlign: 'right',
              paddingRight: 8,
              opacity: 1,
              transition: 'opacity 0.3s, color 0.2s',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = thread.color || '#b89968';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'rgba(71, 71, 71, 0.85)';
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
            flex: 1,
            height: nodeHeight,
            background: isExpanded ? 'rgba(90, 74, 58, 0.04)' : 'transparent', // 温暖的淡棕色背景（仅展开时）
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
                background: thread.color || 'var(--accent, #b89968)',
                opacity: 0.7,
                pointerEvents: 'none',
              }}
            />
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
      onMouseEnter={(e) => {
        setMouseEnterX(e.clientX);
        if (!isPinned) {
          setIsExpanded(true);
        }
      }}
      onMouseLeave={() => {
        if (!isPinned) {
          setIsExpanded(false);
        }
      }}
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: getTimelineHeight(),
        background: 'linear-gradient(to top, #f9f6f1, #fefdfb)',
        borderTop: '1px solid var(--accent-border, #e8dcc8)',
        transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        zIndex: 20,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        padding: isExpanded ? '16px 0' : '0', // 收起时完全去掉 padding
      }}
    >
      {/* Toggle Pin Button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          const newPinned = !isPinned;
          setIsPinned(newPinned);
          if (newPinned) {
            setIsExpanded(true);
          }
        }}
        style={{
          position: 'absolute',
          top: 4,
          right: 8,
          width: 24,
          height: 24,
          borderRadius: 4,
          border: '1px solid var(--accent-border, #e8dcc8)',
          background: isPinned ? 'var(--accent, #b89968)' : '#fefdfb',
          color: isPinned ? '#fefdfb' : '#5a4a3a',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          transition: 'all 0.2s',
          zIndex: 30,
          opacity: isExpanded ? 1 : 0,
          pointerEvents: isExpanded ? 'auto' : 'none',
        }}
        title={isPinned ? '取消固定展开' : '固定展开'}
      >
        📌
      </button>
      
      <div
        ref={scrollContainerRef}
        data-timeline-container
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflowX: 'auto',
          overflowY: isExpanded && needsScroll ? 'auto' : 'hidden',
          paddingRight: isExpanded ? 12 : 0, // 收起时无 padding
          justifyContent: isExpanded ? 'flex-start' : 'center', // 收起时垂直居中
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
      
      {/* Context Menu */}
      {contextMenu && (() => {
        // 估算菜单高度和宽度
        const menuWidth = 320;
        let menuHeight = 60; // 基础高度
        
        if (contextMenu.type === 'node') {
          menuHeight = 200; // 预览区域 + 按钮
          if (contextMenu.nodeSummary) menuHeight += 40;
          if (contextMenu.nodeThreads && contextMenu.nodeThreads.length > 0) menuHeight += 30;
          if (contextMenu.nodeThreads && contextMenu.nodeThreads.length > 1) menuHeight += 40; // Remove from thread button
        }
        
        const position = getContextMenuPosition(contextMenu.x, contextMenu.y, menuWidth, menuHeight);
        
        return (
          <div
            ref={contextMenuRef}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: position.x,
              top: position.y,
              background: '#fefdfb',
              border: '1px solid var(--accent-border, #e8dcc8)',
              borderRadius: 8,
              boxShadow: '0 4px 12px rgba(42, 26, 10, 0.15)',
              minWidth: 200,
              maxWidth: 320,
              zIndex: 1000,
              overflow: 'hidden',
            }}
          >
          {/* Thread 空白处菜单 */}
          {contextMenu.type === 'thread-empty' && (
            <button
              onClick={() => handleContextMenuAction('createChapter')}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                padding: '8px 16px',
                background: 'transparent',
                border: 'none',
                color: '#2a1a0a',
                fontSize: 14,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background-color 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--accent-hover, #f5f0e8)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              ➕ Create Chapter
            </button>
          )}
          
          {/* Node 菜单 - 带预览信息 */}
          {contextMenu.type === 'node' && (
            <>
              {/* 预览信息区域 */}
              <div
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--accent-border, #e8dcc8)',
                  background: '#f9f6f1',
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#2a1a0a',
                    marginBottom: 6,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {contextMenu.nodeTitle}
                </div>
                
                {contextMenu.nodeSummary && (
                  <div
                    style={{
                      fontSize: 11,
                      color: '#5a4a3a',
                      lineHeight: 1.4,
                      maxHeight: 60,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                    }}
                  >
                    {contextMenu.nodeSummary}
                  </div>
                )}
                
                {/* Thread 标签 */}
                {contextMenu.nodeThreads && contextMenu.nodeThreads.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      gap: 4,
                      marginTop: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    {contextMenu.nodeThreads.map((t) => (
                      <span
                        key={t.id}
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: t.color || 'var(--accent, #b89968)',
                          color: '#fff',
                          fontWeight: 500,
                        }}
                      >
                        {t.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              
              {/* 操作按钮 */}
              <button
                onClick={() => handleContextMenuAction('editChapter')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  padding: '8px 16px',
                  background: 'transparent',
                  border: 'none',
                  color: '#2a1a0a',
                  fontSize: 14,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background-color 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--accent-hover, #f5f0e8)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                ✏️ Edit Chapter
              </button>
              
              {contextMenu.nodeThreads && contextMenu.nodeThreads.length > 1 && (
                <button
                  onClick={() => handleContextMenuAction('removeFromThread')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    width: '100%',
                    padding: '8px 16px',
                    background: 'transparent',
                    border: 'none',
                    color: '#2a1a0a',
                    fontSize: 14,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background-color 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--accent-hover, #f5f0e8)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  ➖ Remove Node from Thread
                </button>
              )}
              
              <button
                onClick={() => handleContextMenuAction('deleteNode')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  padding: '8px 16px',
                  background: 'transparent',
                  border: 'none',
                  color: '#c04040',
                  fontSize: 14,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background-color 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#fff0f0';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                🗑️ Delete Entire Node
              </button>
            </>
          )}
          
          {/* 添加到 Thread 菜单 */}
          {contextMenu.type === 'thread-with-selected' && (
            <button
              onClick={() => handleContextMenuAction('addToThread')}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                padding: '8px 16px',
                background: 'transparent',
                border: 'none',
                color: '#2a1a0a',
                fontSize: 14,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background-color 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--accent-hover, #f5f0e8)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              ➕ Add to Thread
            </button>
          )}
          </div>
        );
      })()}
    </div>
  );
}
