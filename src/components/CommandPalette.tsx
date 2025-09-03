import { useEffect, useState, useCallback } from 'react';
import { query } from '../lib/db';
import { useAppStore } from '../store';
import { events } from '../lib/events';
import { Search, FileText, User, MapPin, Package, Users, Lightbulb } from 'lucide-react';

interface SearchResult {
  id: string;
  title: string;
  type: 'node' | 'entry';
  subtype?: string;
  snippet?: string;
}

const typeIcons = {
  node: FileText,
  character: User,
  location: MapPin,
  object: Package,
  faction: Users,
  concept: Lightbulb,
};

export function CommandPalette() {
  const { 
    commandPaletteOpen: open, 
    setCommandPaletteOpen: setOpen,
    setSelectedNodeId,
    setSelectedEntryId,
    setCurrentView
  } = useAppStore();
  
  const [query_text, setQueryText] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const search = useCallback(async (searchTerm: string) => {
    if (!searchTerm.trim()) {
      setResults([]);
      return;
    }

    try {
      const searchResults: SearchResult[] = [];

      // Search nodes by title and content using FTS5
      const nodeResults = await query<{ id: string; title: string; type: string; summary: string }>(`
        SELECT DISTINCT n.id, n.title, n.type, n.summary
        FROM story_node n
        LEFT JOIN fts_block f ON f.node_id = n.id
        WHERE n.title LIKE '%${searchTerm.replaceAll("'", "''")}%'
           OR f.content MATCH '"${searchTerm.replaceAll('"', '""')}"'
        ORDER BY n.order_key
        LIMIT 20
      `);

      searchResults.push(...nodeResults.map(node => ({
        id: node.id,
        title: node.title,
        type: 'node' as const,
        subtype: node.type,
        snippet: node.summary
      })));

      // Search entries by name and summary
      const entryResults = await query<any>(`
        SELECT * FROM entry
        WHERE name LIKE '%${searchTerm.replaceAll("'", "''")}%'
           OR canonical_summary LIKE '%${searchTerm.replaceAll("'", "''")}%'
        ORDER BY created_at DESC
        LIMIT 20
      `);

      searchResults.push(...entryResults.map(entry => ({
        id: entry.id,
        title: entry.name,
        type: 'entry' as const,
        subtype: entry.type,
        snippet: entry.canonical_summary
      })));

      setResults(searchResults);
      setSelectedIndex(0);
      events.emit('search:results', { results: searchResults });
    } catch (error) {
      console.error('Search failed:', error);
      setResults([]);
    }
  }, []);

  useEffect(() => {
    const delayedSearch = setTimeout(() => {
      search(query_text);
    }, 200);

    return () => clearTimeout(delayedSearch);
  }, [query_text, search]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!open);
        if (!open) {
          setQueryText('');
          setResults([]);
        }
      }

      if (!open) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          setOpen(false);
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (results[selectedIndex]) {
            selectResult(results[selectedIndex]);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, setOpen, results, selectedIndex]);

  const selectResult = useCallback((result: SearchResult) => {
    if (result.type === 'node') {
      setSelectedNodeId(result.id);
      setCurrentView('editor');
      events.emit('graph:select', { nodeId: result.id });
    } else if (result.type === 'entry') {
      setSelectedEntryId(result.id);
      setCurrentView('codex');
    }
    
    setOpen(false);
    setQueryText('');
    setResults([]);
  }, [setSelectedNodeId, setSelectedEntryId, setCurrentView, setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16">
      <div className="fixed inset-0 bg-black/40" onClick={() => setOpen(false)} />
      
      <div className="relative z-10 w-full max-w-2xl mx-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center gap-3 p-4 border-b border-neutral-200 dark:border-neutral-800">
          <Search size={18} className="text-neutral-400" />
          <input
            autoFocus
            value={query_text}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="Search nodes and entries... (⌘K)"
            className="flex-1 bg-transparent text-lg outline-none placeholder-neutral-500"
          />
        </div>
        
        <div className="max-h-96 overflow-auto">
          {results.length > 0 ? (
            results.map((result, index) => {
              const Icon = typeIcons[result.subtype as keyof typeof typeIcons] || typeIcons.node;
              const isSelected = index === selectedIndex;
              
              return (
                <div
                  key={`${result.type}-${result.id}`}
                  onClick={() => selectResult(result)}
                  className={`
                    flex items-start gap-3 p-3 cursor-pointer border-b border-neutral-100 dark:border-neutral-800 last:border-b-0
                    ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800'}
                  `}
                >
                  <Icon 
                    size={16} 
                    className={`mt-0.5 flex-shrink-0 ${isSelected ? 'text-blue-600' : 'text-neutral-400'}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{result.title}</div>
                    <div className="text-xs text-neutral-500 capitalize">
                      {result.type} • {result.subtype}
                    </div>
                    {result.snippet && (
                      <div className="text-xs text-neutral-600 dark:text-neutral-400 mt-1 line-clamp-2">
                        {result.snippet}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : query_text.trim() ? (
            <div className="p-8 text-center text-neutral-500">
              No results found for "{query_text}"
            </div>
          ) : (
            <div className="p-8 text-center text-neutral-500">
              <div className="mb-2">Start typing to search...</div>
              <div className="text-xs">
                Search through nodes, entries, and content
              </div>
            </div>
          )}
        </div>

        {results.length > 0 && (
          <div className="border-t border-neutral-200 dark:border-neutral-800 p-2 text-xs text-neutral-500 flex justify-between">
            <span>Use ↑↓ to navigate</span>
            <span>Press Enter to select</span>
          </div>
        )}
      </div>
    </div>
  );
}


