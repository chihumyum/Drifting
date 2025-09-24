import { useEffect, useState, useCallback } from 'react';
import { query, run } from '../lib/db';
import { useAppStore } from '../store';
import { events } from '../lib/events';
import type { Entity, EntityCategory } from '../model/schema';
import { MOCK_ENTITY_CATEGORIES, MOCK_ENTITIES } from '../model/schema';
import { listEntityCategories, ensureEntityCategory } from '../lib/entity';
import { EntityEditor } from '../components/EntityEditor';
import { Plus, Search, User, MapPin, Package, Users, Lightbulb } from 'lucide-react';

const iconMap: Record<string, typeof User> = {
  character: User,
  location: MapPin,
  object: Package,
  faction: Users,
  concept: Lightbulb,
};

const colorMap: Record<string, string> = {
  character: 'bg-blue-50 border-blue-200 text-blue-900',
  location: 'bg-green-50 border-green-200 text-green-900',
  object: 'bg-orange-50 border-orange-200 text-orange-900',
  faction: 'bg-red-50 border-red-200 text-red-900',
  concept: 'bg-purple-50 border-purple-200 text-purple-900',
};

const fallbackColor = 'bg-neutral-200 border-neutral-300 text-neutral-700';

function getCategoryIcon(type: string) {
  return iconMap[type] ?? Lightbulb;
}

function getCategoryColor(type: string) {
  return colorMap[type] ?? fallbackColor;
}

function dedupeCategories(categories: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  categories.forEach((raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  });
  return result;
}

export function EntityView() {
  const {
    entities,
    selectedEntityType,
    selectedEntityId,
    searchQuery,
    setEntities: setEntries,
    addEntity: addEntry,
    removeEntity,
    setSelectedEntityCategory: setSelectedEntityType,
    setSearchQuery,
  } = useAppStore();

  const [newEntityName, setNewEntityName] = useState('');
  const [newEntityCategory, setNewEntityCategory] = useState<string>('new entity category');
  const [categories, setCategories] = useState<EntityCategory[]>(() => [...MOCK_ENTITY_CATEGORIES]);

  const loadEntities = useCallback(async () => {
    try {
  let sql = 'SELECT * FROM entity';

      if (setSelectedEntityType !== 'all') {
        sql += ` WHERE type = '${setSelectedEntityType}'`;
      }

      if (searchQuery.trim()) {
        const searchClause = setSelectedEntityType !== 'all' ? ' AND' : ' WHERE';
        sql += `${searchClause} (name LIKE '%${searchQuery}%' OR canonical_summary LIKE '%${searchQuery}%')`;
      }

      sql += ' ORDER BY created_at DESC';

      const result = await query<Entity>(sql);
      setEntries(result);
    } catch (error) {
      console.error('Failed to load entries:', error);
    }
  }, [setSelectedEntityType, searchQuery, setEntries]);

  useEffect(() => {
    loadEntities();
  }, [loadEntities]);

  useEffect(() => {
    events.on('entity:entity-updated', loadEntities);
    return () => events.off('entity:entity-updated', loadEntities);
  }, [loadEntities]);

  const loadCategories = useCallback(async () => {
    try {
      const rows = await listEntityCategories();
      if (rows.length) {
  setCategories(dedupeCategories([...DEFAULT_entity_CATEGORIES, ...rows.map((row) => row.name)]));
      } else {
  setCategories(dedupeCategories([...DEFAULT_entity_CATEGORIES]));
      }
    } catch (error) {
  console.error('Failed to load entity categories:', error);
    }
  }, []);

  useEffect(() => {
    loadCategories();
    const handle = () => loadCategories();
    events.on('categories:changed', handle);
    events.on('db:ready', handle);
    return () => {
      events.off('categories:changed', handle);
      events.off('db:ready', handle);
    };
  }, [loadCategories]);

  useEffect(() => {
  setCategories((prev) => dedupeCategories([...prev, ...entries.map((entry: any) => entry.type)]));
  }, [entries]);

  useEffect(() => {
    if (setSelectedEntityType !== 'all' && !categories.includes(setSelectedEntityType)) {
      setsetSelectedEntityType('all');
    }
    if (!categories.includes(newEntryType)) {
      setNewEntryType(categories[0] ?? '');
    }
  }, [categories, newEntryType, setSelectedEntityType, setsetSelectedEntityType]);

  const createEntry = useCallback(async () => {
    if (!newEntityName.trim()) return;

    try {
  const entryId = `entity_${Date.now()}`;
      const newEntry: Entity = {
        id: entryId,
        project_id: 'default', // TODO: get from project context
        type: newEntryType,
        name: newEntityName.trim(),
        aliases_json: '[]',
        attributes_json: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      await ensureEntityCategory(newEntryType);
      await run(`
        INSERT INTO entity (id, project_id, type, name, aliases_json, attributes_json, created_at, updated_at)
        VALUES ('${entryId}', '${newEntry.project_id}', '${newEntry.type}', '${newEntry.name}', '${newEntry.aliases_json}', '${newEntry.attributes_json}', '${newEntry.created_at}', '${newEntry.updated_at}')
      `);

      addEntry(newEntry);
      setCategories((prev) => dedupeCategories([...prev, newEntryType]));
      events.emit('codex:entry-created', { entry: newEntry });
      events.emit('entries:changed');
      events.emit('categories:changed');
      
      setNewEntryName('');
    } catch (error) {
      console.error('Failed to create entry:', error);
    }
  }, [newEntityName, newEntryType, addEntry]);

  const deleteEntry = useCallback(async (entryId: string) => {
    try {
  await run(`DELETE FROM entity WHERE id = '${entryId}'`);
      removeEntry(entryId);
      events.emit('codex:entry-deleted', { entryId });
      events.emit('entries:changed');
    } catch (error) {
      console.error('Failed to delete entry:', error);
    }
  }, [removeEntry]);

  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  const filteredEntries = entries.filter(entry => {
    if (setSelectedEntityType !== 'all' && entry.type !== setSelectedEntityType) return false;
    if (searchQuery.trim() && !entry.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="h-full flex flex-col p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Codex</h2>
        <button
          onClick={createEntry}
          className="flex items-center gap-1 px-3 py-1 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700"
        >
          <Plus size={14} />
          Add Entry
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-2 top-2 text-neutral-400" />
          <input
            type="text"
            placeholder="Search entries..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm border border-neutral-300 dark:border-neutral-700 rounded-md bg-transparent focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="flex gap-1 mb-4 text-xs flex-wrap">
        <button
          onClick={() => setsetSelectedEntityType('all')}
          className={`px-2 py-1 rounded ${setSelectedEntityType === 'all' ? 'bg-blue-600 text-white' : 'bg-neutral-200 text-neutral-700'}`}
        >
          All
        </button>
        {categories.map((type) => {
          const Icon = getCategoryIcon(type);
          return (
            <button
              key={type}
              onClick={() => setsetSelectedEntityType(type)}
              className={`flex items-center gap-1 px-2 py-1 rounded capitalize ${
                setSelectedEntityType === type ? 'bg-blue-600 text-white' : 'bg-neutral-200 text-neutral-700'
              }`}
            >
              <Icon size={12} />
              {type}
            </button>
          );
        })}
      </div>

      <div className="flex gap-2 mb-4">
        <div className="flex items-center gap-2">
          <input
            list="codex-categories"
            value={newEntryType}
            onChange={(e) => setNewEntryType(e.target.value)}
            placeholder="Category"
            className="border border-neutral-300 dark:border-neutral-700 rounded px-2 py-1 bg-transparent text-sm w-36"
          />
          <datalist id="codex-categories">
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
          <button
            type="button"
            onClick={() => {
              const value = prompt('新的类别名称', newEntryType) ?? '';
              const trimmed = value.trim();
              if (!trimmed) return;
              ensureEntityCategory(trimmed)
                .then(() => {
                  setCategories((prev) => dedupeCategories([...prev, trimmed]));
                  setNewEntryType(trimmed);
                  events.emit('categories:changed');
                })
                .catch((error) => console.error('Failed to create category:', error));
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-neutral-200 text-neutral-700 hover:bg-neutral-300"
          >
            <Plus size={12} />
            类别
          </button>
        </div>
        <input
          type="text"
          placeholder="Entry name..."
          value={newEntityName}
          onChange={(e) => setNewEntryName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createEntry()}
          className="flex-1 border border-neutral-300 dark:border-neutral-700 rounded px-2 py-1 bg-transparent text-sm"
        />
      </div>

      <div className="flex-1 overflow-auto space-y-2">
        {filteredEntries.map((entry) => {
          const Icon = getCategoryIcon(entry.type);
          const colorClass = getCategoryColor(entry.type);
          
          return (
            <div
              key={entry.id}
              onClick={() => setEditingEntryId(entry.id)}
              className={`
                p-3 rounded-lg border cursor-pointer transition-colors
                ${colorClass}
                ${selectedEntryId === entry.id ? 'ring-2 ring-blue-500' : ''}
              `}
            >
              <div className="flex items-start gap-2">
                <Icon size={16} className="mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{entry.name}</div>
                  <div className="text-xs opacity-70 capitalize">{entry.type}</div>
                  {entry.canonical_summary && (
                    <div className="text-xs mt-1 opacity-80 line-clamp-2">
                      {entry.canonical_summary}
                    </div>
                  )}
                  {entry.aliases_json !== '[]' && (
                    <div className="text-xs mt-1 opacity-60">
                      Aliases: {JSON.parse(entry.aliases_json).join(', ')}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteEntry(entry.id);
                  }}
                  className="text-red-500 hover:text-red-700 text-xs"
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
        
        {filteredEntries.length === 0 && (
          <div className="text-center text-neutral-500 py-8">
            {searchQuery ? 'No entries match your search' : 'No entries yet'}
          </div>
        )}
      </div>
      {editingEntryId && (
        <EntityEditor entityId={editingEntryId} onClose={() => setEditingEntryId(null)} />
      )}
    </div>
  );
}
