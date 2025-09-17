import { useEffect, useState, useCallback } from 'react';
import { useAppStore } from '../store';
import { query, run } from '../lib/db';
import type { StoryNode, Entry } from '../lib/schema';
import { Eye, FileText, CheckSquare, Scissors, User, MapPin, Package, Users, Lightbulb } from 'lucide-react';
import { linkNodeToEntry } from '../lib/codex';

interface LinkedEntry {
  id: string;
  name: string;
  type: string;
  role: string;
  appearances: number;
}

const entryIcons = {
  character: User,
  location: MapPin,
  object: Package,
  faction: Users,
  concept: Lightbulb,
};

export function Sidecar() {
  const {
    sidecarTab: tab,
    setSidecarTab: setTab,
    selectedNodeId,
    selectedEntryId,
    sidecarOpen
  } = useAppStore();

  const [selectedNode, setSelectedNode] = useState<StoryNode | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
  const [linkedEntries, setLinkedEntries] = useState<LinkedEntry[]>([]);
  const [todoItems, setTodoItems] = useState<string[]>([]);
  const [newTodo, setNewTodo] = useState('');
  const [allEntries, setAllEntries] = useState<Entry[]>([]);
  const [entryToLink, setEntryToLink] = useState<string>('');

  const loadNodeDetails = useCallback(async (nodeId: string) => {
    try {
      const nodeRows = await query<StoryNode>(`SELECT * FROM story_node WHERE id = '${nodeId}' LIMIT 1`);
      const node = nodeRows[0] || null;
      setSelectedNode(node);
      if (node) {
        setEditingSummary(node.summary || '');
        setEditingStatus(node.status);
      }

      if (node) {
        const linkRows = await query<LinkedEntry>(`
          SELECT e.id, e.name, e.type, nel.role,
                 COALESCE(COUNT(ea.id), 0) as appearances
          FROM entry e
          LEFT JOIN node_entry_link nel ON nel.entry_id = e.id AND nel.node_id = '${nodeId}'
          LEFT JOIN entry_appearance ea ON ea.entry_id = e.id AND ea.node_id = '${nodeId}'
          WHERE nel.entry_id IS NOT NULL
          GROUP BY e.id, e.name, e.type, nel.role
          ORDER BY appearances DESC, e.name
        `);
        setLinkedEntries(linkRows);

        // Load all entries for linking options
        const entries = await query<Entry>(`SELECT * FROM entry ORDER BY name ASC`);
        setAllEntries(entries);
      }
    } catch (error) {
      console.error('Failed to load node details:', error);
    }
  }, []);

  const loadEntryDetails = useCallback(async (entryId: string) => {
    try {
      const entryRows = await query<Entry>(`SELECT * FROM entry WHERE id = '${entryId}' LIMIT 1`);
      setSelectedEntry(entryRows[0] || null);
    } catch (error) {
      console.error('Failed to load entry details:', error);
    }
  }, []);

  useEffect(() => {
    if (selectedNodeId) {
      loadNodeDetails(selectedNodeId);
    } else {
      setSelectedNode(null);
      setLinkedEntries([]);
    }
  }, [selectedNodeId, loadNodeDetails]);

  useEffect(() => {
    if (selectedEntryId) {
      loadEntryDetails(selectedEntryId);
    } else {
      setSelectedEntry(null);
    }
  }, [selectedEntryId, loadEntryDetails]);

  const addTodoItem = useCallback(() => {
    if (newTodo.trim()) {
      setTodoItems(prev => [...prev, newTodo.trim()]);
      setNewTodo('');
    }
  }, [newTodo]);

  const removeTodoItem = useCallback((index: number) => {
    setTodoItems(prev => prev.filter((_, i) => i !== index));
  }, []);

  if (!sidecarOpen) return null;

  return (
    <div className="h-full flex flex-col bg-white dark:bg-neutral-900 border-l border-neutral-200 dark:border-neutral-800">
      <div className="flex border-b border-neutral-200 dark:border-neutral-800">
        <button 
          className={`flex items-center gap-2 px-3 py-2 text-sm ${tab === 'inspector' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-neutral-600 dark:text-neutral-400'}`}
          onClick={() => setTab('inspector')}
        >
          <Eye size={14} />
          Inspector
        </button>
        <button 
          className={`flex items-center gap-2 px-3 py-2 text-sm ${tab === 'todo' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-neutral-600 dark:text-neutral-400'}`}
          onClick={() => setTab('todo')}
        >
          <CheckSquare size={14} />
          TODO
        </button>
        <button 
          className={`flex items-center gap-2 px-3 py-2 text-sm ${tab === 'snippets' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-neutral-600 dark:text-neutral-400'}`}
          onClick={() => setTab('snippets')}
        >
          <Scissors size={14} />
          Snippets
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {tab === 'inspector' && (
          <div className="space-y-4">
            {selectedNode ? (
              <>
                <div>
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-2">
                    Node Details
                  </h3>
                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="text-neutral-500">Title:</span>
                      <div className="font-medium">{selectedNode.title}</div>
                    </div>
                    <div>
                      <span className="text-neutral-500">Type:</span>
                      <div className="capitalize">{selectedNode.type}</div>
                    </div>
                    <div className="space-y-1">
                      <span className="text-neutral-500">Status:</span>
                      <select
                        value={editingStatus}
                        onChange={(e) => setEditingStatus(e.target.value as StoryNode['status'])}
                        className="text-xs border border-neutral-300 dark:border-neutral-700 rounded px-1 py-0.5 bg-transparent capitalize"
                      >
                        <option value="draft">draft</option>
                        <option value="in_progress">in_progress</option>
                        <option value="complete">complete</option>
                        <option value="archived">archived</option>
                      </select>
                    </div>
                    <div>
                      <span className="text-neutral-500">Summary:</span>
                      <textarea
                        value={editingSummary}
                        onChange={(e) => setEditingSummary(e.target.value)}
                        rows={4}
                        className="w-full text-xs mt-1 p-2 bg-neutral-100 dark:bg-neutral-800 rounded border border-neutral-300 dark:border-neutral-700"
                      />
                      <div className="mt-1 flex justify-end">
                        <button
                          onClick={async () => {
                            if (!selectedNode) return;
                            try {
                              await run(`UPDATE story_node SET summary='${escapeSql(editingSummary)}', status='${editingStatus}', updated_at='${new Date().toISOString()}' WHERE id='${selectedNode.id}'`);
                              await loadNodeDetails(selectedNode.id);
                              events.emit('nodes:changed');
                            } catch (e) { console.error('Failed to update node', e); }
                          }}
                          className="text-xs px-2 py-1 bg-blue-600 text-white rounded"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-2">
                    Linked Entries ({linkedEntries.length})
                  </h3>
                  <div className="space-y-1">
                    {linkedEntries.map((entry) => {
                      const Icon = entryIcons[entry.type as keyof typeof entryIcons] || User;
                      return (
                        <div key={entry.id} className="flex items-center gap-2 p-2 rounded bg-neutral-50 dark:bg-neutral-800">
                          <Icon size={12} className="text-neutral-500" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium truncate">{entry.name}</div>
                            <div className="text-xs text-neutral-500 capitalize">{entry.role}</div>
                          </div>
                          {entry.appearances > 0 && (
                            <div className="text-xs text-neutral-500">
                              {entry.appearances}×
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {linkedEntries.length === 0 && (
                      <div className="text-xs text-neutral-500 italic">No linked entries</div>
                    )}
                  </div>

                  {selectedNode && (
                    <div className="mt-3 p-2 border border-neutral-200 dark:border-neutral-800 rounded">
                      <div className="text-xs text-neutral-600 dark:text-neutral-400 mb-1">Link an entry</div>
                      <div className="flex gap-2">
                        <select
                          value={entryToLink}
                          onChange={(e) => setEntryToLink(e.target.value)}
                          className="flex-1 px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-700 rounded bg-transparent"
                        >
                          <option value="">Select entry…</option>
                          {allEntries
                            .filter(e => !linkedEntries.some(le => le.id === e.id))
                            .map(e => (
                              <option key={e.id} value={e.id}>
                                {e.name} • {e.type}
                              </option>
                            ))}
                        </select>
                        <button
                          onClick={async () => {
                            if (!entryToLink) return;
                            try {
                              await linkNodeToEntry(selectedNode.id, entryToLink, 'present');
                              setEntryToLink('');
                              await loadNodeDetails(selectedNode.id);
                            } catch (err) {
                              console.error('Failed to link entry:', err);
                            }
                          }}
                          className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                        >
                          Link
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : selectedEntry ? (
              <div>
                <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-2">
                  Entry Details
                </h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-neutral-500">Name:</span>
                    <div className="font-medium">{selectedEntry.name}</div>
                  </div>
                  <div>
                    <span className="text-neutral-500">Type:</span>
                    <div className="capitalize">{selectedEntry.type}</div>
                  </div>
                  {selectedEntry.aliases_json !== '[]' && (
                    <div>
                      <span className="text-neutral-500">Aliases:</span>
                      <div className="text-xs">
                        {JSON.parse(selectedEntry.aliases_json).join(', ')}
                      </div>
                    </div>
                  )}
                  {selectedEntry.attributes_json !== '{}' && (
                    <div>
                      <span className="text-neutral-500">Attributes:</span>
                      <div className="text-xs mt-1 p-2 bg-neutral-100 dark:bg-neutral-800 rounded font-mono">
                        {JSON.stringify(JSON.parse(selectedEntry.attributes_json), null, 2)}
                      </div>
                    </div>
                  )}
                  {selectedEntry.canonical_summary && (
                    <div>
                      <span className="text-neutral-500">Summary:</span>
                      <div className="text-xs mt-1 p-2 bg-neutral-100 dark:bg-neutral-800 rounded">
                        {selectedEntry.canonical_summary}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-neutral-500 text-center py-8">
                <FileText size={24} className="mx-auto mb-2 opacity-50" />
                <div className="text-sm">Select a node or entry to view details</div>
              </div>
            )}
          </div>
        )}

        {tab === 'todo' && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              TODO Items
            </h3>
            
            <div className="flex gap-2">
              <input
                type="text"
                value={newTodo}
                onChange={(e) => setNewTodo(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTodoItem()}
                placeholder="Add a TODO item..."
                className="flex-1 px-2 py-1 text-xs border border-neutral-300 dark:border-neutral-700 rounded bg-transparent"
              />
              <button
                onClick={addTodoItem}
                className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Add
              </button>
            </div>

            <div className="space-y-1">
              {todoItems.map((item, index) => (
                <div key={index} className="flex items-center gap-2 p-2 bg-neutral-50 dark:bg-neutral-800 rounded">
                  <input type="checkbox" className="rounded" />
                  <span className="flex-1 text-xs">{item}</span>
                  <button
                    onClick={() => removeTodoItem(index)}
                    className="text-red-500 hover:text-red-700 text-xs"
                  >
                    ×
  const [editingSummary, setEditingSummary] = useState('');
  const [editingStatus, setEditingStatus] = useState<StoryNode['status']>('draft');
                  </button>
                </div>
              ))}
              {todoItems.length === 0 && (
                <div className="text-xs text-neutral-500 italic text-center py-4">
                  No TODO items yet
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'snippets' && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              Text Snippets
            </h3>
            <div className="text-xs text-neutral-500">
              Save reusable text snippets and templates for your writing.
            </div>
            <button className="w-full px-3 py-2 text-xs border border-neutral-300 dark:border-neutral-700 rounded bg-transparent hover:bg-neutral-50 dark:hover:bg-neutral-800">
              + Add Snippet
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function escapeSql(s: string) {
  return s.replaceAll("'", "''");
}
