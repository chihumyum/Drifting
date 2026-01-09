import { create } from 'zustand';
import type { Storyline } from '../domain/storyline';
import type { BookNode, BookNodeEdge } from '../domain/book-node';
import type { BookElement, BookElementCategory } from '../domain/book-element';
import type { NodeTag } from '../domain/node-tag';
import type { ElementTag } from '../schema/book_element';


interface DataState {
  storylines: Storyline[];
  storylineNodeMapping: Record<string, string[]>;
  setStorylines: (storylines: Storyline[]) => void;
  addStoryline: (storyline: Storyline) => void;
  setStorylineNodeMapping: (mapping: Record<string, string[]>) => void;
  
  bookNodes: BookNode[];
  setBookNodes: (nodes: BookNode[]) => void;
  addBookNode: (node: BookNode) => void;
  updateBookNode: (id: string, updates: Partial<BookNode>) => void;
  removeBookNode: (id: string) => void;
  
  nodeEdges: BookNodeEdge[];
  setNodeEdges: (edges: BookNodeEdge[]) => void;


  bookElementCategories: BookElementCategory[];
  setBookElementCategories: (categories: BookElementCategory[]) => void;

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
  setStorylineNodeMapping: (mapping) => set({ storylineNodeMapping: mapping }),
  
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
