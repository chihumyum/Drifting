import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useAppStore } from '../store';
import { useStorylineUsecases } from '../hooks/useStorylineUsecases';
import { useBookNodeUsecases } from '../hooks/useBookNodeUsecases';
import { createBookContentRepository } from '../repositories/book_content_sqlite';
import { parseOutline } from '../lib/outline';
import type { OutlineItem } from '../schema/book_content';
import type { Storyline } from '../domain/storyline';
import type { BookNode } from '../domain/book_node';
import { useAuthStore, getProjectId } from '../store/auth';
import { NodeHoverPreview } from './NodeHoverPreview';

// Timeline 配置
const TIMELINE_CONFIG = {
  GRID_UNIT: 20, // 每个网格单位占用的像素宽度
  NODE_MIN_WIDTH: 40, // 节点最小宽度（2个网格单位）
  NODE_DEFAULT_WIDTH: 4, // 节点默认宽度（以网格单位计）
  NODE_MIN_HEIGHT: 18, // 节点最小高度 - 隐藏时只显示标题
  NODE_EXPANDED_HEIGHT: 60, // 展开时节点理想高度
  NODE_COMPACT_HEIGHT: 6, // 收起时节点高度
  STORYLINE_PADDING: 2, // 每个 storyline 行的上下内边距（展开时）
  STORYLINE_PADDING_COMPACT: 0, // 每个 storyline 行的上下内边距（收起时，无内边距）
  STORYLINE_GAP: 2, // storyline 之间的间隔（展开时）
  STORYLINE_GAP_COMPACT: 0, // storyline 之间的间隔（收起时，无间隔）
  RESIZE_HANDLE_WIDTH: 8, // 调整大小手柄的宽度
};

interface TimelineNode extends BookNode {
  storylines: Storyline[];
}

export function BottomTimeline() {
  const navigate = useNavigate();
  const location = useLocation();
  const { storylineId } = useParams<{ storylineId?: string }>();
  const { bookNodes, selectedNodeId } = useAppStore();
  const storedStorylines = useAppStore(state => state.storylines); // Get storylines from store
  const user = useAuthStore(state => state.user);
  const storylineUsecases = useStorylineUsecases();
  const nodeUsecases = useBookNodeUsecases();
  const contentRepo = useRef(createBookContentRepository()).current;
  
  const [storylines, setStorylines] = useState<Storyline[]>([]);
  const [nodesWithStorylines, setNodesWithStorylines] = useState<TimelineNode[]>([]);
  const [nodeOutlines, setNodeOutlines] = useState<Map<string, OutlineItem[]>>(new Map());
  const [isExpanded, setIsExpanded] = useState(true);
  const [isResizingHeight, setIsResizingHeight] = useState(false); // 是否正在调整高度
  const [draggedNode, setDraggedNode] = useState<{ node: TimelineNode; storylineId: string } | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<{ storylineId: string; start: number; x: number } | null>(null);
  const [customTotalHeight, setCustomTotalHeight] = useState<number | null>(null); // 用户自定义的bottomTimeline总高度
  
  // Context Menu 状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: 'storyline-empty' | 'node' | 'storyline-with-selected';
    storylineId?: string;
    nodeId?: string;
    position?: number;
    // Node 预览信息
    nodeTitle?: string;
    nodeSummary?: string | null;
    nodeStorylines?: Storyline[];
  } | null>(null);
  
  // 节点边缘 hover 状态
  const [hoveredEdge, setHoveredEdge] = useState<{ nodeId: string; edge: 'left' | 'right' } | null>(null);
  
  // 悬停预览相关状态
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; y: number } | null>(null);
  
  // 节点宽度（以 grid 单位计）- 使用 Map 存储每个节点的 end 值
  const [nodeEnds, setNodeEnds] = useState<Map<string, number | null>>(new Map());
  
  // 调整大小的状态
  const [resizingNode, setResizingNode] = useState<{
    nodeId: string;
    storylineId: string;
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
  }, [storylines.length]); // Restore after storylines are loaded
  
  // 添加全局快捷键 Cmd+J 来切换展开/收起
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setIsExpanded(prev => !prev);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);



  // 从 localStorage 恢复自定义总高度
  useEffect(() => {
    const savedTotalHeight = localStorage.getItem('timeline-total-height');
    if (savedTotalHeight) {
      setCustomTotalHeight(parseInt(savedTotalHeight, 10));
    }
  }, []);

  // 处理高度调整的拖拽
  useEffect(() => {
    if (!isResizingHeight) return;

    const handleMouseMove = (e: MouseEvent) => {
      const windowHeight = window.innerHeight;
      const newTimelineHeight = Math.max(120, windowHeight - e.clientY);
      setCustomTotalHeight(newTimelineHeight);
    };

    const handleMouseUp = () => {
      setIsResizingHeight(false);
      // 保存总高度到 localStorage
      if (customTotalHeight !== null) {
        localStorage.setItem('timeline-total-height', customTotalHeight.toString());
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingHeight, customTotalHeight]);


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
    const node = nodesWithStorylines.find(n => n.id === nodeId);
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
  const minStart = nodesWithStorylines.length > 0 ? Math.min(...nodesWithStorylines.map(n => n.start)) : 0;
  const maxEnd = nodesWithStorylines.length > 0 
    ? Math.max(...nodesWithStorylines.map(n => n.end ?? (n.start + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH))) 
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
    if (storylines.length === 0) {
      console.error('No storylines found, should not happen');
      return 120;
    }
    
    if (isExpanded) {
      return customTotalHeight ?? 280;
    } else {
      return storylines.length * (TIMELINE_CONFIG.NODE_COMPACT_HEIGHT + TIMELINE_CONFIG.STORYLINE_PADDING_COMPACT * 2);
    }
  };


  
  // 更新全局 timeline 高度
  useEffect(() => {
    const height = getTimelineHeight();
    const currentHeight = useAppStore.getState().timelineHeight;
    // Only update if height actually changed to prevent infinite loops
    if (height !== currentHeight) {
      useAppStore.getState().setTimelineHeight(height);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded, storylines.length, customTotalHeight]);

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

  // Load storylines and node-storyline relationships
  useEffect(() => {
    async function loadData() {
      try {
        const projectId = getProjectId(user?.id);
        
        // If store has storylines, use them; otherwise load from database
        let allStorylines: Storyline[];
        if (storedStorylines.length > 0) {
          allStorylines = storedStorylines;
        } else {
          allStorylines = await storylineUsecases.getStorylinesByProject(projectId);
          // Sync to store so other components can access it
          useAppStore.getState().setStorylines(allStorylines);
        }
        
        setStorylines(allStorylines);

        // Load storyline info for each node
        const nodesWithStorylineInfo = await Promise.all(
          bookNodes.map(async (node) => {
            const nodeStorylines = await storylineUsecases.getStorylinesByNode(node.id);
            return { ...node, storylines: nodeStorylines };
          })
        );
        setNodesWithStorylines(nodesWithStorylineInfo);
        
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
    
    // Always load storylines, even if there are no nodes yet
    loadData();
  }, [bookNodes, storylineUsecases, user, storedStorylines]);

  // Load outlines for all nodes
  useEffect(() => {
    async function loadOutlines() {
      try {
        const outlinesMap = new Map<string, OutlineItem[]>();
        
        for (const node of nodesWithStorylines) {
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
    
    if (nodesWithStorylines.length > 0) {
      loadOutlines();
    }
  }, [nodesWithStorylines, contentRepo]);

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
          if (contextMenu.type === 'storyline-empty' && contextMenu.storylineId && contextMenu.position) {
            // 创建新章节
            const newNode = await nodeUsecases.createNode({
              title: 'New Chapter',
              start: contextMenu.position,
              end: contextMenu.position + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH,
            });
            
            // 将 node 添加到用户指定的 storyline
            // 因为这是第一个 storyline，storyline_order=0，它将成为此 node 的 primary storyline
            await storylineUsecases.addNodeToStoryline(newNode.id, contextMenu.storylineId);
            
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
          
        case 'removeFromStoryline':
          if (contextMenu.type === 'node' && contextMenu.nodeId && contextMenu.storylineId) {
            // 获取当前 node 的所有 storylines
            const nodeStorylines = await storylineUsecases.getStorylinesByNode(contextMenu.nodeId);
            
            // 如果这是唯一的 storyline，删除整个 node
            if (nodeStorylines.length === 1) {
              await nodeUsecases.deleteNode(contextMenu.nodeId);
              // 如果删除的是当前选中的节点，清除选中并导航
              if (selectedNodeId === contextMenu.nodeId) {
                useAppStore.getState().setSelectedNodeId(null);
                navigate('/editor');
              }
            } else {
              // 检查是否删除的是主 storyline（第一个 storyline）
              const isRemovingPrimaryStoryline = nodeStorylines.length > 0 && nodeStorylines[0].id === contextMenu.storylineId;
              
              if (isRemovingPrimaryStoryline) {
                // 如果删除主 storyline 且还有其他 storylines，将剩余的 storylines 重新排序
                const remainingStorylineIds = nodeStorylines
                  .filter(t => t.id !== contextMenu.storylineId)
                  .map(t => t.id);
                
                // 第一个剩余的 storyline 会成为新的主 storyline
                await storylineUsecases.setNodeStorylines(contextMenu.nodeId, remainingStorylineIds);
              } else {
                // 如果不是主 storyline，直接删除
                await storylineUsecases.removeNodeFromStoryline(contextMenu.nodeId, contextMenu.storylineId);
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
          
        case 'addToStoryline':
          if (contextMenu.type === 'storyline-with-selected' && contextMenu.storylineId && selectedNodeId) {
            // 添加选中的节点到此 storyline
            await storylineUsecases.addNodeToStoryline(selectedNodeId, contextMenu.storylineId);
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
  const handleNodeDragStart = (e: React.DragEvent, node: TimelineNode, storylineId: string) => {
    setDraggedNode({ node, storylineId });
    e.dataTransfer.effectAllowed = 'move';
  };

  // Handle drag over - 计算应该放在哪个 start 位置
  const handleNodeDragOver = (e: React.DragEvent, storylineId: string) => {
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
    
    setDragOverPosition({ storylineId, start, x: mouseX });
  };

  // Handle drop
  const handleDrop = async (e: React.DragEvent, targetStorylineId: string) => {
    e.preventDefault();
    if (!draggedNode || !dragOverPosition) return;

    const { node, storylineId: sourceStorylineId } = draggedNode;
    const targetStart = dragOverPosition.start;
    
    try {
      // Check if this is a primary storyline (first storyline in node.storylines)
      const isPrimaryStoryline = node.storylines.length > 0 && node.storylines[0].id === sourceStorylineId;
      const isTargetInNodeStorylines = node.storylines.some(t => t.id === targetStorylineId);
      
      // Only allow dragging from primary storyline
      if (!isPrimaryStoryline) {
        console.warn('Can only drag from primary storyline');
        return;
      }
      
      // If dropped in a different storyline
      if (sourceStorylineId !== targetStorylineId) {
        if (isTargetInNodeStorylines) {
          // Target storyline already belongs to this node
          // Keep source storyline, but make target storyline the new primary
          const newStorylineOrder = [
            targetStorylineId,
            ...node.storylines.filter(t => t.id !== targetStorylineId).map(t => t.id)
          ];
          await storylineUsecases.setNodeStorylines(node.id, newStorylineOrder);
        } else {
          // Target storyline is new to this node
          // Remove old primary storyline and add target as new primary
          await storylineUsecases.removeNodeFromStoryline(node.id, sourceStorylineId);
          
          // Add target storyline as the first (primary) storyline
          const remainingStorylineIds = node.storylines
            .filter(t => t.id !== sourceStorylineId)
            .map(t => t.id);
          await storylineUsecases.setNodeStorylines(node.id, [targetStorylineId, ...remainingStorylineIds]);
        }
      }

      // Update start position if changed (and maintain position regardless of storyline changes)
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
  const handleNodeResizeStart = (e: React.MouseEvent, nodeId: string, storylineId: string, edge: 'left' | 'right') => {
    e.stopPropagation();
    e.preventDefault();
    
    const node = nodesWithStorylines.find((n) => n.id === nodeId);
    if (!node) return;
    
    const end = nodeEnds.get(nodeId) ?? node.end ?? (node.start + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH);
    
    setResizingNode({
      nodeId,
      storylineId,
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
        setNodesWithStorylines((prev) => 
          prev.map((n) => 
            n.id === resizingNode.nodeId ? { ...n, start: validStart } : n
          )
        );
      }
    };
    
    const handleNodeResizeEnd = async () => {
      if (resizingNode) {
        const node = nodesWithStorylines.find((n) => n.id === resizingNode.nodeId);
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
      document.addEventListener('mouseup', handleNodeResizeEnd);
      
      return () => {
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleNodeResizeEnd);
      };
    }
  }, [resizingNode, nodeUsecases, nodesWithStorylines, nodeEnds]);

  // Handle node click
  const handleNodeClick = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止事件冒泡到 timeline 背景
    // 设置选中状态
    useAppStore.getState().setSelectedNodeId(nodeId);
    // 避免重复导航到同一页面
    if (location.pathname !== `/editor/${nodeId}`) {
      navigate(`/editor/${nodeId}`);
    }
  };

  // 悬停预览事件处理
  const handleNodeMouseEnter = (node: TimelineNode, e: React.MouseEvent) => {
    setHoveredNodeId(node.id);
    const rect = e.currentTarget.getBoundingClientRect();
    // 根据 bottom timeline 的位置，将浮窗显示在节点上方
    setHoverPosition({
      x: rect.left + rect.width / 2,
      y: rect.top - 8, // 显示在上方
    });
  };

  const handleNodeMouseLeave = () => {
    setHoveredNodeId(null);
    setHoverPosition(null);
  };

  // Handle timeline background click (deselect)
  const handleTimelineClick = () => {
    // 只在展开时响应点击
    if (!isExpanded) return;
    // 点击任何空白处都取消选择（事件会被节点和按钮拦截）
    useAppStore.getState().setSelectedNodeId(null);
  };

  // 判断一个 node 是否应该在当前 storyline 上作为"主显示"
  // 规则：在 node 的第一个 storyline 上完整显示，其他 storylines 上显示连接点
  const isPrimaryStorylineForNode = (node: TimelineNode, storylineId: string): boolean => {
    if (node.storylines.length === 0) return false;
    return node.storylines[0].id === storylineId;
  };

  // 渲染连接线和标记点（用于跨多个 storylines 的 node）
  const renderNodeConnections = (node: TimelineNode, currentStorylineIndex: number) => {
    // 只有当 node 在多个 storylines 中时才渲染连接
    if (node.storylines.length <= 1) return null;
    
    // 找到主 storyline 的索引（第一个 storyline）
    const primaryStorylineId = node.storylines[0].id;
    const primaryStorylineIndex = storylines.findIndex(t => t.id === primaryStorylineId);
    
    if (primaryStorylineIndex === -1) return null;
    
    // 只在主 storyline 上显示连接指示（简化版本）
    if (currentStorylineIndex !== primaryStorylineIndex) return null;
    
    // 显示一个简单的标记表示该节点在多个 storylines 中
    return (
      <div
        style={{
          position: 'absolute',
          right: 4,
          top: 4,
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: storylines.find(t => t.id === primaryStorylineId)?.color || '#b89968',
          opacity: 0.6,
          pointerEvents: 'none',
          zIndex: 10,
        }}
        title={`This node appears in ${node.storylines.length} storylines`}
      />
    );
  };

  // Render a single node card
  const renderNodeCard = (node: TimelineNode, storylineId: string) => {
    const storyline = storylines.find((t) => t.id === storylineId);
    const isSelected = selectedNodeId === node.id;
    const isPrimary = isPrimaryStorylineForNode(node, storylineId);
    const currentStorylineIndex = storylines.findIndex(t => t.id === storylineId);
    const defaultColor = '#00355bff';
    
    // startToPosition 已经处理了 minStart 偏移和缩放
    const leftPosition = startToPosition(node.start);
    const nodeWidth = getNodeWidth(node.id);
    
    // 如果不是主 storyline，显示标记点而不是完整 node
    if (!isPrimary && node.storylines.length > 1) {
      const markerSize = isExpanded ? 12 : 6;
      const isHovered = hoveredNodeId === node.id;
      return (
        <div
          key={`${node.id}-${storylineId}-marker`}
          data-node-card
          onClick={(e) => handleNodeClick(node.id, e)}
          onMouseEnter={(e) => handleNodeMouseEnter(node, e)}
          onMouseLeave={handleNodeMouseLeave}
          style={{
            position: 'absolute',
            left: leftPosition + nodeWidth / 2 - markerSize / 2,
            top: '50%',
            transform: isExpanded ? 'translateY(-50%)' : `translateY(-50%) scale(${isHovered ? 1.3 : 1})`,
            width: markerSize,
            height: markerSize,
            borderRadius: '50%',
            background: isSelected && !isExpanded
              ? `radial-gradient(circle, ${storyline?.color || defaultColor}, ${storyline?.color || defaultColor}dd)`
              : (storyline?.color || defaultColor),
            border: isExpanded ? `2px solid ${storyline?.color || defaultColor}` : 'none',
            boxShadow: isSelected 
              ? (isExpanded 
                ? `0 0 0 3px rgba(255, 255, 255, 0.8), 0 0 0 5px ${storyline?.color || defaultColor}` 
                : `0 0 8px 2px ${storyline?.color || defaultColor}80, 0 0 16px 4px ${storyline?.color || defaultColor}40`)
              : isExpanded ? `0 2px 4px ${storyline?.color}60` : 'none',
            cursor: 'pointer',
            opacity: isExpanded ? (isSelected ? 1 : 0.9) : (isSelected ? 1 : (isHovered ? 0.95 : 0.7)),
            filter: !isExpanded && isSelected ? 'brightness(1.3) saturate(1.2)' : 'none',
            transition: isExpanded ? 'none' : 'transform 0.15s ease, opacity 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease',
            zIndex: isSelected ? 10 : 5,
          }}
          title={isExpanded ? `${node.title} (from ${node.storylines[0]?.name || 'another storyline'})` : undefined}
        />
      );
    }
    
    // 主 storyline 上显示完整 node
    // 检测当前节点是否有边缘 hover
    const edgeHover = hoveredEdge?.nodeId === node.id ? hoveredEdge.edge : null;
    
    const handleMouseMove = (e: React.MouseEvent) => {
      // 收起时不检测边缘
      if (isExpanded) {
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
      }
      
      // 触发悬停预览
      if (!edgeHover && hoveredNodeId !== node.id) {
        handleNodeMouseEnter(node, e);
      }
    };

    const isHovered = hoveredNodeId === node.id;

    return (
      <div
        key={`${node.id}-${storylineId}`}
        data-node-card
        draggable={!edgeHover && isPrimary && isExpanded}
        onDragStart={(e) => isExpanded && handleNodeDragStart(e, node, storylineId)}
        onDragEnd={handleDragEnd}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          setHoveredEdge(null);
          handleNodeMouseLeave();
        }}
        onMouseDown={(e) => {
          if (edgeHover && isExpanded) {
            handleNodeResizeStart(e, node.id, storylineId, edgeHover);
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
          height: '100%',
          background: isExpanded 
            ? '#fefdfb' 
            : (isSelected 
              ? `linear-gradient(135deg, ${storyline?.color || defaultColor} 0%, ${storyline?.color || defaultColor}dd 50%, ${storyline?.color || defaultColor} 100%)`
              : (storyline?.color || defaultColor)),
          borderRadius: isExpanded ? 6 : 3,
          cursor: edgeHover ? 'ew-resize' : (isPrimary && isExpanded ? 'grab' : 'pointer'),
          borderTop: isExpanded ? (`1px solid ${storyline?.color || defaultColor}`) : 'none',
          borderBottom: isExpanded ? (`1px solid ${storyline?.color || defaultColor}`) : 'none',
          borderLeft: isExpanded ? (`1px solid ${storyline?.color || defaultColor}`) : 'none',
          borderRight: isExpanded ? (`1px solid ${storyline?.color || defaultColor}`) : 'none',
          boxShadow: isExpanded 
            ? (isSelected ? `0 2px 8px ${storyline?.color || defaultColor}40` : '0 1px 4px rgba(90, 74, 58, 0.1)') 
            : (isSelected 
              ? `0 0 12px 3px ${storyline?.color || defaultColor}60, 0 0 24px 6px ${storyline?.color || defaultColor}30, inset 0 0 20px ${storyline?.color || defaultColor}20`
              : 'none'),
          opacity: isExpanded ? 1 : (isHovered ? 0.95 : 0.85),
          filter: !isExpanded && isSelected ? 'brightness(1.2) saturate(1.3) contrast(1.1)' : 'none',
          transform: isExpanded ? 'none' : `scale(${isHovered ? 1.05 : 1})`,
          transition: isExpanded ? 'none' : 'transform 0.15s ease, opacity 0.15s ease, filter 0.15s ease, box-shadow 0.3s ease',
        }}
      >
        {/* 连接线 - 如果node在多个storylines中 */}
        {node.storylines.length > 1 && renderNodeConnections(node, currentStorylineIndex)}
        
        {/* Outline 刻度线背景层 - 仅展开时显示 */}
        {isExpanded && (() => {
          const outline = nodeOutlines.get(node.id);
          if (!outline || outline.length === 0) return null;

          // 计算刻度线的位置分布
          const calculateRulerPositions = () => {
            const h1Items = outline.filter(item => item.level === 1);
            const h2Items = outline.filter(item => item.level === 2);
            const h3Items = outline.filter(item => item.level === 3);

              // 展开状态：显示所有层级，均匀分布
              const positions: { left: string; level: number; isParagraph?: boolean }[] = [];

              // H1 均分整个宽度
              h1Items.forEach((h1, index) => {
                const h1Start = (index / h1Items.length) * 100;
                const h1End = ((index + 1) / h1Items.length) * 100;
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
                  h2InThisH1.forEach((h2, h2Index) => {
                    const h2Start = h1Start + (h2Index / h2InThisH1.length) * (h1End - h1Start);
                    const h2End = h1Start + ((h2Index + 1) / h2InThisH1.length) * (h1End - h1Start);
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
                      h3InThisH2.forEach((h3, h3Index) => {
                        const h3Start = h2Start + (h3Index / h3InThisH2.length) * (h2End - h2Start);
                        const h3End = h2Start + ((h3Index + 1) / h3InThisH2.length) * (h2End - h2Start);
                        const h3Position = h2Start + ((h3Index + 0.5) / h3InThisH2.length) * (h2End - h2Start);
                        positions.push({ left: `${h3Position}%`, level: 3 });
                        
                        // 添加 H3 后的 paragraph 次级刻度
                        const h3ParagraphCount = h3.paragraphsAfter || 0;
                        if (h3ParagraphCount > 0) {
                          for (let p = 0; p < h3ParagraphCount; p++) {
                            const pPosition = h3Start + ((p + 1) / (h3ParagraphCount + 1)) * (h3End - h3Start);
                            positions.push({ left: `${pPosition}%`, level: 3, isParagraph: true });
                          }
                        }
                      });
                    } else {
                      // H2 后没有 H3，添加 H2 的 paragraph 次级刻度
                      const h2ParagraphCount = h2.paragraphsAfter || 0;
                      if (h2ParagraphCount > 0) {
                        for (let p = 0; p < h2ParagraphCount; p++) {
                          const pPosition = h2Start + ((p + 1) / (h2ParagraphCount + 1)) * (h2End - h2Start);
                          positions.push({ left: `${pPosition}%`, level: 2, isParagraph: true });
                        }
                      }
                    }
                  });
                } else {
                  // H1 后没有 H2，添加 H1 的 paragraph 次级刻度
                  const h1ParagraphCount = h1.paragraphsAfter || 0;
                  if (h1ParagraphCount > 0) {
                    for (let p = 0; p < h1ParagraphCount; p++) {
                      const pPosition = h1Start + ((p + 1) / (h1ParagraphCount + 1)) * (h1End - h1Start);
                      positions.push({ left: `${pPosition}%`, level: 1, isParagraph: true });
                    }
                  }
                }
              });
              return positions;
          };

          const rulerPositions = calculateRulerPositions();

          return (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: '10%', // 展开时只占底部 10px，收起时占满
                pointerEvents: 'none', // 不阻挡点击事件
                zIndex: 0, // 作为背景层
                backgroundColor: 'transparent',
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
                    width:  pos.isParagraph ? 0.5 : 1,
                    height:  pos.isParagraph ? 4 : (pos.level === 1 ? 8 : pos.level === 2 ? 6 : 4),
                    backgroundColor: pos.isParagraph  ? 'rgba(128, 128, 128, 0.4)' : (storyline?.color || '#b89968'),
                    borderRadius: 0.5,
                    opacity: pos.isParagraph ? 0.6 : 0.8,
                  }}
                />
              ))}
            </div>
          );
        })()}
        
        {/* 内容前景层 - 仅展开时显示 */}
        {isExpanded && (
          <div 
            style={{
              position: 'relative', 
              zIndex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '4px 8px 4px 8px',
              height: '100%',
              boxSizing: 'border-box',
              minHeight: 0,
            }}
          >
            {/* 标题 - 使用 container query 或者固定逻辑 */}
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'rgba(71, 71, 71, 0.85)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {node.title}
            </div>
            
            {/* 摘要 - 使用 flex 自动处理溢出 */}
            {node.summary && (
              <div
                style={{
                  fontSize: 9,
                  color: 'rgba(71, 71, 71, 0.65)',
                  overflow: 'hidden',
                  flex: 1,
                  minHeight: 0,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  lineHeight: '1.3',
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

  // Render a single storyline row using absolute positioning
  const renderStorylineRow = (storyline: Storyline) => {
    const nodesInStoryline = nodesWithStorylines.filter((n) => n.storylines.some((t) => t.id === storyline.id));
    
    // 检查选中的节点是否属于当前 storyline
    const selectedNode = nodesWithStorylines.find((n) => n.id === selectedNodeId);
    const selectedNodeBelongsToStoryline = selectedNode?.storylines.some((t) => t.id === storyline.id);

    return (
      <div
        key={storyline.id}
        onDragOver={(e) => isExpanded && handleNodeDragOver(e, storyline.id)}
        onDrop={(e) => isExpanded && handleDrop(e, storyline.id)}
        onClick={(e) => {
          // 检查是否点击在节点上
          const target = e.target as HTMLElement;
          const isNodeClick = target.closest('[data-node-card]');
          
          if (!isNodeClick) {
            // 点击在空白区域，导航到 storyline editor
            useAppStore.getState().setSelectedNodeId(null);
            if (location.pathname !== `/editor/storyline/${storyline.id}`) {
              navigate(`/editor/storyline/${storyline.id}`);
            }
          }
        }}
        onContextMenu={(e) => {
          // 收起时禁用右键菜单
          if (!isExpanded) return;
          
          e.preventDefault();
          const container = e.currentTarget.querySelector('[data-node-container]') as HTMLElement;
          if (!container) return;
          
          const rect = container.getBoundingClientRect();
          const x = e.clientX - rect.left;
          
          // 从像素位置转换为 start（timeline position）
          const position = Math.max(1, Math.round(x / TIMELINE_CONFIG.GRID_UNIT) + 1);
          
          // 检查是否点击在某个 node 上
          const clickedNode = nodesInStoryline.find(node => {
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
              storylineId: storyline.id,
              nodeTitle: clickedNode.title,
              nodeSummary: clickedNode.summary,
              nodeStorylines: clickedNode.storylines,
            });
          } else if (selectedNodeId && !selectedNodeBelongsToStoryline) {
            // 选中了某个 node，且点击在空白处，可以添加 node 到此 storyline
            setContextMenu({
              x: e.clientX + 2,
              y: e.clientY - 2,
              type: 'storyline-with-selected',
              storylineId: storyline.id,
            });
          } else {
            // Storyline 空白处，可以新增 chapter
            setContextMenu({
              x: e.clientX + 2,
              y: e.clientY - 2,
              type: 'storyline-empty',
              storylineId: storyline.id,
              position,
            });
          }
        }}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          flex: 1,
          minHeight: isExpanded ? TIMELINE_CONFIG.NODE_MIN_HEIGHT : TIMELINE_CONFIG.NODE_COMPACT_HEIGHT,
          marginBottom: isExpanded ? TIMELINE_CONFIG.STORYLINE_GAP : TIMELINE_CONFIG.STORYLINE_GAP_COMPACT,
          marginTop: isExpanded ? TIMELINE_CONFIG.STORYLINE_GAP : TIMELINE_CONFIG.STORYLINE_GAP_COMPACT,
          gap: isExpanded ? 12 : 8, // 收起时减小 gap
          // padding: `${isExpanded ? TIMELINE_CONFIG.STORYLINE_PADDING : TIMELINE_CONFIG.STORYLINE_PADDING_COMPACT}px 0`,
        }}
      >
        {/* Node container with absolute positioning */}
        <div
          data-node-container
          style={{
            position: 'relative',
            flex: 1,
            height: '100%',
            background: storylineId === storyline.id
              ? (isExpanded ? `${storyline.color || '#b89968'}15` : 'transparent')
              : (isExpanded ? 'rgba(90, 74, 58, 0.04)' : 'transparent'),
            borderRadius: 4,
            minWidth: timelineWidth,
            cursor: 'pointer',
          }}
        >
          {/* Render drop indicator */}
          {dragOverPosition?.storylineId === storyline.id && (
            <div
              style={{
                position: 'absolute',
                left: dragOverPosition.x,
                top: 0,
                width: 2,
                height: '100%',
                background: storyline.color || 'var(--accent, #b89968)',
                opacity: 0.7,
                pointerEvents: 'none',
              }}
            />
          )}

          {/* Render nodes */}
          {nodesInStoryline.map((node) => renderNodeCard(node, storyline.id))}

          {/* Empty state */}
          {nodesInStoryline.length === 0 && !draggedNode && (
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
              No chapters in this storyline
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
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: getTimelineHeight(),
        background: 'linear-gradient(to top, #f9f6f1, #fefdfb)',
        borderTop: '1px solid var(--accent-border, #e8dcc8)',
        zIndex: 20,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        padding: isExpanded ? '4px 0' : '0', // 收起时完全去掉 padding
      }}
    >
      {/* 可拖拽的顶部边框 - 仅在展开时显示 */}
      {isExpanded && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsResizingHeight(true);
          }}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 4,
            cursor: 'ns-resize',
            zIndex: 30,
          }}
        />
      )}
      <div
        ref={scrollContainerRef}
        data-timeline-container
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          overflowX: 'auto',
          overflowY: 'hidden',
          paddingLeft: isExpanded ? 16 : 0, // 左侧 padding
          paddingRight: isExpanded ? 16 : 0, // 右侧 padding
          justifyContent: isExpanded ? 'flex-start' : 'center', // 收起时垂直居中
          // 隐藏滚动条但保持滚动功能
          scrollbarWidth: 'none', // Firefox
          msOverflowStyle: 'none', // IE and Edge
          WebkitOverflowScrolling: 'touch', // iOS smooth scrolling
        }}
        // 隐藏滚动条 - Webkit (Chrome, Safari)
        className="timeline-scroll-container"
      >
        {storylines.length > 0 ? (
          storylines.map((storyline) => renderStorylineRow(storyline))
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
            Loading storylines...
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
          if (contextMenu.nodeStorylines && contextMenu.nodeStorylines.length > 0) menuHeight += 30;
          if (contextMenu.nodeStorylines && contextMenu.nodeStorylines.length > 1) menuHeight += 40; // Remove from storyline button
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
          {/* Storyline 空白处菜单 */}
          {contextMenu.type === 'storyline-empty' && (
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
                
                {/* Storyline 标签 */}
                {contextMenu.nodeStorylines && contextMenu.nodeStorylines.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      gap: 4,
                      marginTop: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    {contextMenu.nodeStorylines.map((t) => (
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
              
              {contextMenu.nodeStorylines && contextMenu.nodeStorylines.length > 1 && (
                <button
                  onClick={() => handleContextMenuAction('removeFromStoryline')}
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
                  ➖ Remove Node from Storyline
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
          
          {/* 添加到 Storyline 菜单 */}
          {contextMenu.type === 'storyline-with-selected' && (
            <button
              onClick={() => handleContextMenuAction('addToStoryline')}
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
              ➕ Add to Storyline
            </button>
          )}
          </div>
        );
      })()}
      
      {/* Hover Preview */}
      <NodeHoverPreview 
        node={hoveredNodeId ? nodesWithStorylines.find(n => n.id === hoveredNodeId) ?? null : null}
        position={hoverPosition}
        showAbove={true}
      />
    </div>
  );
}
