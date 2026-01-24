import { create } from 'zustand';
import type { Storyline } from '../domain/storyline';
import type { StoryNode, StoryNodeEdge } from '../domain/story-node';
import type { BookElement, BookElementCategory } from '../domain/book-element';
import type { NodeTag } from '../domain/node-tag';
// Type definition moved from schema
export interface ElementTag {
  id: string;
  element_id: string;
  stage_id?: string;
  name: string;
  created_at: string;
}


interface DataState {
  storylines: Storyline[];
  storylineNodeMapping: Record<string, string[]>;
  setStorylines: (storylines: Storyline[]) => void;
  addStoryline: (storyline: Storyline) => void;
  updateStoryline: (id: string, updates: Partial<Storyline>) => void;
  removeStoryline: (id: string) => void;
  setStorylineNodeMapping: (mapping: Record<string, string[]>) => void;
  addNodeToStorylineMapping: (storylineId: string, nodeId: string) => void;
  removeNodeFromStorylineMapping: (storylineId: string, nodeId: string) => void;
  setNodeStorylinesMapping: (nodeId: string, storylineIds: string[]) => void;
  
  bookNodes: StoryNode[];
  setBookNodes: (nodes: StoryNode[]) => void;
  addBookNode: (node: StoryNode) => void;
  updateBookNode: (id: string, updates: Partial<StoryNode>) => void;
  removeBookNode: (id: string) => void;
  
  nodeEdges: StoryNodeEdge[];
  setNodeEdges: (edges: StoryNodeEdge[]) => void;


  bookElementCategories: BookElementCategory[];
  setBookElementCategories: (categories: BookElementCategory[]) => void;
  addBookElementCategory: (category: BookElementCategory) => void;
  updateBookElementCategory: (id: string, updates: Partial<BookElementCategory>) => void;
  removeBookElementCategory: (id: string) => void;

  bookElements: BookElement[];
  setBookElements: (elements: BookElement[]) => void;
  addBookElement: (element: BookElement) => void;
  updateBookElement: (id: string, updates: Partial<BookElement>) => void;
  removeBookElement: (id: string) => void;

  nodeTags: NodeTag[];
  setNodeTags: (tags: NodeTag[]) => void;
  addNodeTag: (tag: NodeTag) => void;
  updateNodeTag: (id: string, updates: Partial<NodeTag>) => void;
  removeNodeTag: (id: string) => void;

  elementTags: ElementTag[];
  setElementTags: (tags: ElementTag[]) => void;
  addElementTag: (tag: ElementTag) => void;
  updateElementTag: (id: string, updates: Partial<ElementTag>) => void;
  removeElementTag: (id: string) => void;

}

export const useDataStore = create<DataState>((set) => ({
  storylines: [],
  storylineNodeMapping: {},
  addStoryline: (storyline) => set((state) => ({ storylines: [...state.storylines, storyline] })),
  setStorylines: (storylines) => set({ storylines }),
  updateStoryline: (id, updates) => set((state) => ({
    storylines: state.storylines.map((storyline) => storyline.id === id ? { ...storyline, ...updates } : storyline),
  })),
  removeStoryline: (id) => set((state) => ({ storylines: state.storylines.filter((storyline) => storyline.id !== id) })),
  setStorylineNodeMapping: (mapping) => set({ storylineNodeMapping: mapping }),
  addNodeToStorylineMapping: (storylineId, nodeId) => set((state) => ({
    storylineNodeMapping: {
      ...state.storylineNodeMapping,
      [storylineId]: [...(state.storylineNodeMapping[storylineId] || []), nodeId]
    }
  })),
  removeNodeFromStorylineMapping: (storylineId, nodeId) => set((state) => ({
    storylineNodeMapping: {
      ...state.storylineNodeMapping,
      [storylineId]: (state.storylineNodeMapping[storylineId] || []).filter((id) => id !== nodeId)
    }
  })),
  setNodeStorylinesMapping: (nodeId, storylineIds) => set((state) => {
    const newMapping = { ...state.storylineNodeMapping };
    
    // Remove nodeId from all storylines where it shouldn't be
    Object.keys(newMapping).forEach(slId => {
      if (!storylineIds.includes(slId)) {
        newMapping[slId] = newMapping[slId].filter(id => id !== nodeId);
      }
    });

    // Add nodeId to all storylines where it should be
    storylineIds.forEach(slId => {
       const existingNodes = newMapping[slId] || [];
       if (!existingNodes.includes(nodeId)) {
         newMapping[slId] = [...existingNodes, nodeId];
       }
    });
    
    return { storylineNodeMapping: newMapping };
  }),
  
  bookNodes: [],
  nodeEdges: [],
  setBookNodes: (bookNodes) => set({ bookNodes }),
  addBookNode: (bookNode) => set((state) => ({ bookNodes: [...state.bookNodes, bookNode] })),
  updateBookNode: (id, updates) => set((state) => ({
    bookNodes: state.bookNodes.map((node) => {
      if (node.id !== id) return node;
      const position = updates.position ? { ...node.position, ...updates.position } : node.position;
      return {
        ...node,
        ...updates,
        position,
      };
    }),
  })),
  removeBookNode: (id) => set((state) => ({ bookNodes: state.bookNodes.filter((node) => node.id !== id) })),
  setNodeEdges: (edges) => set({ nodeEdges: edges }),
  
  bookElementCategories: [],
  setBookElementCategories: (elementCategories) => set({ bookElementCategories: elementCategories }),
  addBookElementCategory: (category) => set((state) => ({ bookElementCategories: [...state.bookElementCategories, category] })),
  updateBookElementCategory: (id, updates) => set((state) => ({
    bookElementCategories: state.bookElementCategories.map((category) => category.id === id ? { ...category, ...updates } : category),
  })),
  removeBookElementCategory: (id) => set((state) => ({ bookElementCategories: state.bookElementCategories.filter((category) => category.id !== id) })),
  
  bookElements: [],
  setBookElements: (bookElements) => set({ bookElements }),
  addBookElement: (element) => set((state) => ({ bookElements: [...state.bookElements, element] })),
  updateBookElement: (id, updates) => set((state) => ({
    bookElements: state.bookElements.map((element) => element.id === id ? { ...element, ...updates } : element),
  })),
  removeBookElement: (id) => set((state) => ({ bookElements: state.bookElements.filter((element) => element.id !== id) })),
  
  nodeTags: [],
  setNodeTags: (tags) => set({ nodeTags: tags }),
  addNodeTag: (tag) => set((state) => ({ nodeTags: [...state.nodeTags, tag] })),
  updateNodeTag: (id, updates) => set((state) => ({
    nodeTags: state.nodeTags.map((tag) => tag.id === id ? { ...tag, ...updates } : tag),
  })),
  removeNodeTag: (id) => set((state) => ({ nodeTags: state.nodeTags.filter((tag) => tag.id !== id) })),

  elementTags: [],
  setElementTags: (tags) => set({ elementTags: tags }),
  addElementTag: (tag) => set((state) => ({ elementTags: [...state.elementTags, tag] })),
  updateElementTag: (id, updates) => set((state) => ({
    elementTags: state.elementTags.map((tag) => tag.id === id ? { ...tag, ...updates } : tag),
  })),
  removeElementTag: (id) => set((state) => ({ elementTags: state.elementTags.filter((tag) => tag.id !== id) })),

}));
