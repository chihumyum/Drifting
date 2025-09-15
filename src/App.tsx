import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { GraphView } from './views/GraphView';
import { OutlineView } from './views/OutlineView';
import { TimelineView } from './views/TimelineView';
import { EditorView } from './views/EditorView';
import { CodexView } from './views/CodexView';
import { CommandPalette } from './components/CommandPalette';
import { useAppStore } from './store';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { useEntitiesStore } from './store/entities';
import { EntityEditor } from './components/EntityEditor';

function Layout() {
  const { 
    setCommandPaletteOpen 
  } = useAppStore();
  
  const { 
    chapters, 
    entityTypes,
    addChapter, 
    addEntity,
    addEntityType,
    getEntitiesByType,
    storyStages 
  } = useEntitiesStore();

  const [editingEntity, setEditingEntity] = useState<string | null>(null);
  const [newEntityType, setNewEntityType] = useState('');

  useEffect(() => {
    // Initialize database on app start
    initDatabase().then(() => {
      events.emit('db:ready');
    }).catch(error => {
      console.error('Failed to initialize database:', error);
      events.emit('db:error', { error: error.message });
    });
  }, []);

  const handleKeyboardShortcuts = (e: KeyboardEvent) => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const cmdKey = isMac ? e.metaKey : e.ctrlKey;

    if (cmdKey && e.key === 'k') {
      e.preventDefault();
      setCommandPaletteOpen(true);
    }
  };

  useEffect(() => {
    window.addEventListener('keydown', handleKeyboardShortcuts);
    return () => window.removeEventListener('keydown', handleKeyboardShortcuts);
  }, []);

  return (
    <div style={{ height: '100vh', display: 'flex', backgroundColor: '#f5f5f5' }}>
      <CommandPalette />
      
      {/* Left Column 1 - Outline Panel */}
      <aside style={{ 
        width: '200px', 
        backgroundColor: '#e8d5e8', 
        borderRight: '1px solid #ccc',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px'
      }}>
        <div style={{ 
          padding: '16px 0',
          borderBottom: '1px solid #ccc',
          marginBottom: '16px'
        }}>
          <h1 style={{ fontSize: '18px', fontWeight: 'bold', margin: '0 0 8px 0' }}>OutLine</h1>
        </div>
        
        {/* Chapter List */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {chapters.map((chapter) => (
            <div key={chapter.id} style={{ 
              padding: '8px', 
              backgroundColor: '#d4c5d4', 
              borderRadius: '4px', 
              fontSize: '14px',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span>{chapter.title}</span>
              <span style={{ fontSize: '10px', opacity: 0.7 }}>{chapter.storyStage}</span>
            </div>
          ))}
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <select
              onChange={(e) => {
                if (e.target.value) {
                  addChapter({
                    title: 'New Chapter',
                    content: 'Enter your chapter content here...',
                    storyStage: e.target.value,
                    characters: [],
                    locations: []
                  });
                  e.target.value = '';
                }
              }}
              style={{
                padding: '8px',
                backgroundColor: '#c4b5c4',
                borderRadius: '4px',
                border: '1px dashed #999',
                fontSize: '12px',
                cursor: 'pointer'
              }}
            >
              <option value="">+ Add Chapter to...</option>
              {storyStages.map(stage => (
                <option key={stage.id} value={stage.name}>
                  {stage.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </aside>
      
      {/* Left Column 2 - Entities Panel */}
      <aside style={{ 
        width: '200px', 
        backgroundColor: '#e8d5e8', 
        borderRight: '1px solid #ccc',
        padding: '16px',
        overflowY: 'auto'
      }}>
        {/* Add New Entity Type */}
        <div style={{ marginBottom: '16px', padding: '8px', backgroundColor: '#d4c5d4', borderRadius: '4px' }}>
          <input
            type="text"
            placeholder="New entity type..."
            value={newEntityType}
            onChange={(e) => setNewEntityType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newEntityType.trim()) {
                addEntityType(newEntityType.trim());
                setNewEntityType('');
              }
            }}
            style={{
              width: '100%',
              padding: '4px 8px',
              border: '1px solid #ccc',
              borderRadius: '4px',
              fontSize: '12px'
            }}
          />
          {newEntityType.trim() && (
            <button
              onClick={() => {
                addEntityType(newEntityType.trim());
                setNewEntityType('');
              }}
              style={{
                marginTop: '4px',
                width: '100%',
                padding: '4px',
                backgroundColor: '#c4b5c4',
                border: '1px solid #999',
                borderRadius: '4px',
                fontSize: '11px',
                cursor: 'pointer'
              }}
            >
              Add Type
            </button>
          )}
        </div>

        {/* Entity Types */}
        {entityTypes.map((entityType) => {
          const typeEntities = getEntitiesByType(entityType);
          return (
            <div key={entityType} style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 'bold', margin: 0, textTransform: 'capitalize' }}>
                  {entityType}s
                </h3>
                <button
                  onClick={() => addEntity({ 
                    name: `New ${entityType}`, 
                    type: entityType, 
                    description: '',
                    color: entityType === 'character' ? '#e3f2fd' : entityType === 'location' ? '#fff3e0' : '#f3e5f5'
                  })}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px' }}
                >
                  +
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {typeEntities.map((entity) => (
                  <div 
                    key={entity.id} 
                    onClick={() => setEditingEntity(entity.id)}
                    style={{ 
                      fontSize: '12px', 
                      padding: '6px 8px', 
                      cursor: 'pointer',
                      backgroundColor: entity.color || '#f0f0f0',
                      borderRadius: '4px',
                      border: '1px solid #ddd',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <span>{entity.name}</span>
                    <span style={{ fontSize: '10px', opacity: 0.7 }}>{entity.type}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </aside>
      
      {/* Main Content Area - Story Stages */}
      <main style={{ 
        flex: 1, 
        display: 'flex', 
        flexDirection: 'column',
        overflow: 'hidden'
      }}>
        {/* Top Navigation */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '16px',
          borderBottom: '1px solid #ccc',
          backgroundColor: 'white'
        }}>
          <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 'normal' }}>Spring - The novel creator</h1>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={{ padding: '4px 8px', fontSize: '12px', backgroundColor: '#f0f0f0', border: '1px solid #ccc', borderRadius: '4px' }}>Graph</button>
            <button style={{ padding: '4px 8px', fontSize: '12px', backgroundColor: '#f0f0f0', border: '1px solid #ccc', borderRadius: '4px' }}>Timeline</button>
            <button style={{ padding: '4px 8px', fontSize: '12px', backgroundColor: '#f0f0f0', border: '1px solid #ccc', borderRadius: '4px' }}>Tree</button>
          </div>
        </div>

        {/* React Flow Story Canvas */}
        <div style={{ 
          flex: 1, 
          backgroundColor: '#e8e8e8'
        }}>
          <GraphView />
        </div>
      </main>
      
      {/* Entity Editor Modal */}
      {editingEntity && (
        <EntityEditor 
          entityId={editingEntity} 
          onClose={() => setEditingEntity(null)} 
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<GraphView />} />
        <Route path="graph" element={<GraphView />} />
        <Route path="outline" element={<OutlineView />} />
        <Route path="timeline" element={<TimelineView />} />
        <Route path="editor" element={<EditorView />} />
        <Route path="codex" element={<CodexView />} />
      </Route>
    </Routes>
  )
}
