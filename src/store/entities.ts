import { create } from 'zustand';

interface Entity {
  id: string;
  name: string;
  type: string;
  description: string;
  color?: string;
}

interface Chapter {
  id: string;
  title: string;
  content: string;
  storyStage: string;
  characters: string[];
  locations: string[];
}

interface StoryStage {
  id: string;
  name: string;
  chapters: string[];
}

interface EntitiesStore {
  entities: Entity[];
  chapters: Chapter[];
  storyStages: StoryStage[];
  entityTypes: string[];
  
  // Actions
  addEntity: (entity: Omit<Entity, 'id'>) => void;
  addEntityType: (type: string) => void;
  addChapter: (chapter: Omit<Chapter, 'id'>) => void;
  addStoryStage: (storyStage: Omit<StoryStage, 'id'>) => void;
  
  updateChapter: (id: string, updates: Partial<Chapter>) => void;
  updateEntity: (id: string, updates: Partial<Entity>) => void;
  
  deleteEntity: (id: string) => void;
  deleteChapter: (id: string) => void;
  
  // Convenience getters
  getEntitiesByType: (type: string) => Entity[];
  getCharacters: () => Entity[];
  getLocations: () => Entity[];
}

export const useEntitiesStore = create<EntitiesStore>((set, get) => ({
  entities: [
    { id: 'char-1', name: 'character', type: 'character', description: '', color: '#e3f2fd' },
    { id: 'char-2', name: 'character', type: 'character', description: '', color: '#e3f2fd' },
    { id: 'char-3', name: 'character', type: 'character', description: '', color: '#e3f2fd' },
    { id: 'char-4', name: 'character', type: 'character', description: '', color: '#e3f2fd' },
    { id: 'loc-1', name: 'location', type: 'location', description: '', color: '#fff3e0' },
    { id: 'loc-2', name: 'location', type: 'location', description: '', color: '#fff3e0' },
    { id: 'loc-3', name: 'location', type: 'location', description: '', color: '#fff3e0' },
    { id: 'loc-4', name: 'location', type: 'location', description: '', color: '#fff3e0' },
  ],
  entityTypes: ['character', 'location'],
  chapters: [
    {
      id: 'chapter-1',
      title: 'chapter',
      content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
      storyStage: 'Story Stage 1',
      characters: ['char-1', 'char-2', 'char-3', 'char-4'],
      locations: ['loc-1']
    },
    {
      id: 'chapter-2', 
      title: 'chapter',
      content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet.',
      storyStage: 'Story Stage 2',
      characters: ['char-1', 'char-2', 'char-3'],
      locations: ['loc-1', 'loc-2']
    },
    {
      id: 'chapter-3',
      title: 'chapter', 
      content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
      storyStage: 'Story Stage 3',
      characters: [],
      locations: []
    }
  ],
  storyStages: [
    { id: 'stage-1', name: 'Story Stage 1', chapters: ['chapter-1'] },
    { id: 'stage-2', name: 'Story Stage 2', chapters: ['chapter-2'] },
    { id: 'stage-3', name: 'Story Stage 3', chapters: ['chapter-3'] }
  ],

  addEntity: (entity) => set((state) => ({
    entities: [...state.entities, { ...entity, id: `${entity.type}-${Date.now()}` }]
  })),

  addEntityType: (type) => set((state) => ({
    entityTypes: state.entityTypes.includes(type) ? state.entityTypes : [...state.entityTypes, type]
  })),

  addChapter: (chapter) => set((state) => ({
    chapters: [...state.chapters, { ...chapter, id: `chapter-${Date.now()}` }]
  })),

  addStoryStage: (storyStage) => set((state) => ({
    storyStages: [...state.storyStages, { ...storyStage, id: `stage-${Date.now()}` }]
  })),

  updateChapter: (id, updates) => set((state) => ({
    chapters: state.chapters.map(ch => ch.id === id ? { ...ch, ...updates } : ch)
  })),

  updateEntity: (id, updates) => set((state) => ({
    entities: state.entities.map(entity => entity.id === id ? { ...entity, ...updates } : entity)
  })),

  deleteEntity: (id) => set((state) => ({
    entities: state.entities.filter(entity => entity.id !== id)
  })),

  // Convenience getters
  getEntitiesByType: (type) => get().entities.filter(entity => entity.type === type),
  getCharacters: () => get().entities.filter(entity => entity.type === 'character'),
  getLocations: () => get().entities.filter(entity => entity.type === 'location'),

  deleteChapter: (id) => set((state) => ({
    chapters: state.chapters.filter(ch => ch.id !== id)
  })),
}));