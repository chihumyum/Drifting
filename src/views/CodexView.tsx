import { useEffect, useState, useCallback } from 'react';
import { query, run } from '../lib/db';
import { useAppStore } from '../store';
import { events } from '../lib/events';
import type { Entry, EntryType } from '../lib/schema';
import { EntityEditor } from '../components/EntityEditor';
import { Plus, Search, User, MapPin, Package, Users, Lightbulb } from 'lucide-react';

const entryIcons = {
  character: User,
  location: MapPin,
  object: Package,
  faction: Users,
  concept: Lightbulb,
};

const entryColors = {
  character: 'bg-blue-50 border-blue-200 text-blue-900',
  location: 'bg-green-50 border-green-200 text-green-900',
  object: 'bg-orange-50 border-orange-200 text-orange-900',
  faction: 'bg-red-50 border-red-200 text-red-900',
  concept: 'bg-purple-50 border-purple-200 text-purple-900',
};

export function CodexView() {
  const {
    entries,
    selectedEntryType,
    selectedEntryId,
    searchQuery,
    setEntries,
    addEntry,
    removeEntry,
    setSelectedEntryType,
    setSelectedEntryId,
    setSearchQuery,
  } = useAppStore();

  const [newEntryName, setNewEntryName] = useState('');
  const [newEntryType, setNewEntryType] = useState<EntryType>('character');

  const loadEntries = useCallback(async () => {
    try {
      let sql = 'SELECT * FROM entry';

      if (selectedEntryType !== 'all') {
        sql += ` WHERE type = '${selectedEntryType}'`;
      }

      if (searchQuery.trim()) {
        const searchClause = selectedEntryType !== 'all' ? ' AND' : ' WHERE';
        sql += `${searchClause} (name LIKE '%${searchQuery}%' OR canonical_summary LIKE '%${searchQuery}%')`;
      }

      sql += ' ORDER BY created_at DESC';

      const result = await query<Entry>(sql);
      setEntries(result);
    } catch (error) {
      console.error('Failed to load entries:', error);
    }
  }, [selectedEntryType, searchQuery, setEntries]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    events.on('entries:changed', loadEntries);
    return () => events.off('entries:changed', loadEntries);
  }, [loadEntries]);

  const createEntry = useCallback(async () => {
    if (!newEntryName.trim()) return;

    try {
      const entryId = `entry_${Date.now()}`;
      const newEntry: Entry = {
        id: entryId,
        project_id: 'default', // TODO: get from project context
        type: newEntryType,
        name: newEntryName.trim(),
        aliases_json: '[]',
        attributes_json: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      await run(`
        INSERT INTO entry (id, project_id, type, name, aliases_json, attributes_json, created_at, updated_at)
        VALUES ('${entryId}', '${newEntry.project_id}', '${newEntry.type}', '${newEntry.name}', '${newEntry.aliases_json}', '${newEntry.attributes_json}', '${newEntry.created_at}', '${newEntry.updated_at}')
      `);

      addEntry(newEntry);
      events.emit('codex:entry-created', { entry: newEntry });
      events.emit('entries:changed');
      
      setNewEntryName('');
    } catch (error) {
      console.error('Failed to create entry:', error);
    }
  }, [newEntryName, newEntryType, addEntry]);

  const deleteEntry = useCallback(async (entryId: string) => {
    try {
      await run(`DELETE FROM entry WHERE id = '${entryId}'`);
      removeEntry(entryId);
      events.emit('codex:entry-deleted', { entryId });
      events.emit('entries:changed');
    } catch (error) {
      console.error('Failed to delete entry:', error);
    }
  }, [removeEntry]);

  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  const filteredEntries = entries.filter(entry => {
    if (selectedEntryType !== 'all' && entry.type !== selectedEntryType) return false;
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

      <div className="flex gap-1 mb-4 text-xs">
        <button
          onClick={() => setSelectedEntryType('all')}
          className={`px-2 py-1 rounded ${selectedEntryType === 'all' ? 'bg-blue-600 text-white' : 'bg-neutral-200 text-neutral-700'}`}
        >
          All
        </button>
        {(['character', 'location', 'object', 'faction', 'concept'] as EntryType[]).map(type => {
          const Icon = entryIcons[type];
          return (
            <button
              key={type}
              onClick={() => setSelectedEntryType(type)}
              className={`flex items-center gap-1 px-2 py-1 rounded capitalize ${
                selectedEntryType === type ? 'bg-blue-600 text-white' : 'bg-neutral-200 text-neutral-700'
              }`}
            >
              <Icon size={12} />
              {type}
            </button>
          );
        })}
      </div>

      <div className="flex gap-2 mb-4">
        <select
          value={newEntryType}
          onChange={(e) => setNewEntryType(e.target.value as EntryType)}
          className="border border-neutral-300 dark:border-neutral-700 rounded px-2 py-1 bg-transparent text-sm"
        >
          <option value="character">Character</option>
          <option value="location">Location</option>
          <option value="object">Object</option>
          <option value="faction">Faction</option>
          <option value="concept">Concept</option>
        </select>
        <input
          type="text"
          placeholder="Entry name..."
          value={newEntryName}
          onChange={(e) => setNewEntryName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createEntry()}
          className="flex-1 border border-neutral-300 dark:border-neutral-700 rounded px-2 py-1 bg-transparent text-sm"
        />
      </div>

      <div className="flex-1 overflow-auto space-y-2">
        {filteredEntries.map((entry) => {
          const Icon = entryIcons[entry.type];
          const colorClass = entryColors[entry.type];
          
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
