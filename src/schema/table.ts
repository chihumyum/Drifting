import type { Project } from "./book_general";
import type { ElementRecord, ElementCategoryRecord } from "./book_element";



export const TABLES = {
  project: 'project',
  storyNode: 'story_node',
  nodeEdge: 'node_edge',
  nodeBlock: 'node_block',
  entity: 'entity',
  entityStage: 'entity_stage',
} as const


export const DB_SCHEMA = `
`;



export const DEFAULT_PROJECT: Project = {
  id: 'project_mock_1',
  name: 'My First Story',
  author: 'Author Name',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

export const DEFAULT_ENTITY_CATEGORY: ElementCategoryRecord = {
  name: 'others',
  color: '#CCCCCC',
  created_at: new Date().toISOString(),
}

export const MOCK_ENTITY_CATEGORIES: ElementCategoryRecord[] = [
  {
    name: 'character',
    color: '#FF6B6B',
    created_at: new Date().toISOString(),
  },
  {
    name: 'location',
    color: '#4ECDC4',
    created_at: new Date().toISOString(),
  },
  {
    name: 'object',
    color: '#FFD93D',
    created_at: new Date().toISOString(),
  },
  {
    name: 'faction',
    color: '#1A535C',
    created_at: new Date().toISOString(),
  },
  {
    name: 'concept',
    color: '#9368B7',
    created_at: new Date().toISOString(),
  },
];
export const MOCK_ENTITIES: ElementRecord[] = [
  {
    id: 'entity_mock_1',
    project_id: 'project_mock_1',
    type: 'character',
    name: 'Aria Thorn',
    aliases_json: JSON.stringify(['The Wanderer', 'AT']),
    attributes_json: JSON.stringify({ role: 'protagonist', temperament: 'curious', age: 19 }),
    canonical_summary: 'Central protagonist seeking the lost citadel.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'entity_mock_2',
    project_id: 'project_mock_1',
    type: 'location',
    name: 'Elder Oakspire',
    aliases_json: JSON.stringify(['The Whispering Tree']),
    attributes_json: JSON.stringify({ type: 'ancient_tree', region: 'Northwood', mystical: true }),
    canonical_summary: 'A sentient tree holding fragmented memories of the realm.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'entity_mock_3',
    project_id: 'project_mock_1',
    type: 'object',
    name: 'Shard Compass',
    aliases_json: JSON.stringify(['Fractured Navigator']),
    attributes_json: JSON.stringify({ material: 'obsidian + silver', attuned: true }),
    canonical_summary: 'An artifact that points toward emotional fractures in reality.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'entity_mock_4',
    project_id: 'project_mock_1',
    type: 'faction',
    name: 'Order of the Veil',
    aliases_json: JSON.stringify(['Veilkeepers']),
    attributes_json: JSON.stringify({ influence: 'regional', secrecy_level: 8 }),
    canonical_summary: 'A clandestine faction guarding forbidden chronomancy.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'entity_mock_5',
    project_id: 'project_mock_1',
    type: 'concept',
    name: 'Echo Convergence',
    aliases_json: JSON.stringify(['Resonance Event']),
    attributes_json: JSON.stringify({ cycle: 'once / century', stability: 'volatile' }),
    canonical_summary: 'A periodic phenomenon where timelines partially overlap.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];
