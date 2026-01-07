import { Plus } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBookNodeUsecases } from '../../hooks/useBookNodeUsecases';
import { useStorylineUsecases } from '../../hooks/useStorylineUsecases';
import { useAppStore } from '../../store';
import { useAuthStore, getProjectId } from '../../store/auth';
import log from "loglevel";

log.setLevel(log.levels.ERROR);

export function CreateChapterButton() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore(state => state.user);
  const { createNode, loadNodes, updateNode } = useBookNodeUsecases();
  const storylineUsecases = useStorylineUsecases();
  const bookNodes = useAppStore(state => state.bookNodes);
  const selectedNodeId = useAppStore(state => state.selectedNodeId);

  // Check if we're currently in a storyline editor
  const getCurrentStorylineId = (): string | null => {
    const match = location.pathname.match(/^\/editor\/storyline\/([^/]+)$/);
    return match ? match[1] : null;
  };

  const handleCreateChapter = async () => {
    try {
      // Determine target storyline
      let defaultStorylineId: string | null = null;
      
      // Priority 1: Use current storyline if in storyline editor
      const currentStorylineId = getCurrentStorylineId();
      if (currentStorylineId) {
        defaultStorylineId = currentStorylineId;
      }
      // Priority 2: Use selected node's primary storyline
      else if (selectedNodeId) {
        const selectedNodeStorylines = await storylineUsecases.getStorylinesByNode(selectedNodeId);
        if (selectedNodeStorylines.length > 0) {
          defaultStorylineId = selectedNodeStorylines[0].id;
        }
      }
      
      // Priority 3: Use first available storyline
      if (!defaultStorylineId) {
        const projectId = getProjectId(user?.id);
        const allStorylines = await storylineUsecases.getStorylinesByProject(projectId);
        if (allStorylines.length > 0) {
          defaultStorylineId = allStorylines[0].id;
        }
      }

      // Calculate insertion position
      let newStart = 1;
      let newEnd = 11; // Default length of 10 units
      const newLength = 10;
      
      // If in storyline editor, always insert at the end of current storyline
      // regardless of selectedNodeId
      if (currentStorylineId && defaultStorylineId) {
        // Insert after last node in the current storyline
        const nodesWithStorylines = await Promise.all(
          bookNodes.map(async (node) => {
            const nodeStorylines = await storylineUsecases.getStorylinesByNode(node.id);
            return { ...node, storylines: nodeStorylines };
          })
        );
        
        const nodesInStoryline = nodesWithStorylines
          .filter(n => n.storylines.length > 0 && n.storylines[0].id === defaultStorylineId)
          .sort((a, b) => a.start - b.start);
        
        if (nodesInStoryline.length > 0) {
          const lastNode = nodesInStoryline[nodesInStoryline.length - 1];
          const lastEnd = lastNode.end ?? lastNode.start;
          newStart = lastEnd + 1;
          newEnd = newStart + newLength;
        } else {
          // Storyline is empty, place at beginning
          newStart = 1;
          newEnd = newStart + newLength;
        }
      } else if (selectedNodeId) {
        // Insert after selected node (when not in storyline editor)
        const selectedNode = bookNodes.find(n => n.id === selectedNodeId);
        if (selectedNode) {
          const selectedEnd = selectedNode.end ?? selectedNode.start;
          newStart = selectedEnd + 1;
          newEnd = newStart + newLength;
        }
      } else if (defaultStorylineId) {
        // Insert after last node in the target storyline
        // Get all nodes with their storylines
        const nodesWithStorylines = await Promise.all(
          bookNodes.map(async (node) => {
            const nodeStorylines = await storylineUsecases.getStorylinesByNode(node.id);
            return { ...node, storylines: nodeStorylines };
          })
        );
        
        // Filter nodes where this storyline is the primary (first) storyline
        const nodesInStoryline = nodesWithStorylines
          .filter(n => n.storylines.length > 0 && n.storylines[0].id === defaultStorylineId)
          .sort((a, b) => a.start - b.start);
        
        if (nodesInStoryline.length > 0) {
          // Place after last node in storyline
          const lastNode = nodesInStoryline[nodesInStoryline.length - 1];
          const lastEnd = lastNode.end ?? lastNode.start;
          newStart = lastEnd + 1;
          newEnd = newStart + newLength;
        } else {
          // Storyline is empty, place at beginning
          newStart = 1;
          newEnd = newStart + newLength;
        }
      }
      
      // Check if there are any nodes in the target storyline overlapping with [newStart, newEnd]
      // and shift all subsequent nodes if necessary
      if (defaultStorylineId) {
        // Get all nodes with their storylines
        const nodesWithStorylines = await Promise.all(
          bookNodes.map(async (node) => {
            const nodeStorylines = await storylineUsecases.getStorylinesByNode(node.id);
            return { ...node, storylines: nodeStorylines };
          })
        );
        
        // Filter nodes where this storyline is the primary (first) storyline
        const storylineNodes = nodesWithStorylines
          .filter(n => n.storylines.length > 0 && n.storylines[0].id === defaultStorylineId)
          .sort((a, b) => a.start - b.start);
        
        // Find first overlapping node
        const firstOverlap = storylineNodes.find(node => {
          const nodeStart = node.start;
          const nodeEnd = node.end ?? node.start;
          return nodeStart < newEnd && nodeEnd >= newStart;
        });
        
        if (firstOverlap) {
          // Shift amount is the length of the new chapter
          const shiftAmount = newEnd - newStart;
          
          // Shift all nodes from the first overlap onwards
          const nodesToShift = storylineNodes.filter(node => node.start >= firstOverlap.start);
          
          for (const node of nodesToShift) {
            await updateNode(node.id, {
              start: node.start + shiftAmount,
              end: node.end ? node.end + shiftAmount : null,
            });
          }
        }
      }
      
      // Create the new node
      const newNode = await createNode({
        title: 'New Chapter',
        start: newStart,
        end: newEnd,
      });
      
      if (defaultStorylineId) {
        await storylineUsecases.addNodeToStoryline(newNode.id, defaultStorylineId);
      }
      
      await loadNodes();
      useAppStore.getState().setSelectedNodeId(newNode.id);
      navigate(`/editor/${newNode.id}`);
      
      // Scroll timeline to the new chapter
      setTimeout(() => {
        const timelineContainer = document.querySelector('[data-timeline-container]') as HTMLElement;
        if (timelineContainer) {
          const GRID_UNIT = 20;
          const scrollPosition = newStart * GRID_UNIT;
          timelineContainer.scrollTo({
            left: scrollPosition,
            behavior: 'smooth',
          });
        }
      }, 100);
    } catch (error) {
      log.error('Failed to create chapter:', error);
    }
  };

  return (
    <button
      onClick={handleCreateChapter}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 6,
        border: '1px solid rgba(184, 153, 104, 0.3)',
        background: 'rgba(184, 153, 104, 0.1)',
        color: 'rgba(0, 0, 0, 0.75)',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        WebkitAppRegion: 'no-drag',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'rgba(184, 153, 104, 0.2)';
        e.currentTarget.style.borderColor = 'rgba(184, 153, 104, 0.4)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'rgba(184, 153, 104, 0.1)';
        e.currentTarget.style.borderColor = 'rgba(184, 153, 104, 0.3)';
      }}
    >
      <Plus size={16} />
      <span>Chapter</span>
    </button>
  );
}
