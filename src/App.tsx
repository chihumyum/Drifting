import { useEffect } from 'react';
import { Route, Routes, Outlet, useNavigate } from 'react-router-dom';
import { GraphView } from './views/GraphView';
import { OutlineView } from './views/OutlineView';
import { TimelineView } from './views/TimelineView';
import { EditorView } from './views/EditorView';
import { CodexView } from './views/CodexView';
import { CommandPalette } from './components/CommandPalette';
import { useAppStore } from './store';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { Sidecar } from './components/Sidecar';
import { OutlinePanel } from './components/OutlinePanel';

function Layout() {
  const { setCommandPaletteOpen } = useAppStore();
  const navigate = useNavigate();

  useEffect(() => {
    initDatabase().then(() => {
      events.emit('db:ready');
    }).catch(error => {
      console.error('Failed to initialize database:', error);
      events.emit('db:error', { error: error.message });
    });
  }, []);

  useEffect(() => {
    const handleKeyboardShortcuts = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const cmdKey = isMac ? e.metaKey : e.ctrlKey;
      if (cmdKey && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyboardShortcuts);
    return () => window.removeEventListener('keydown', handleKeyboardShortcuts);
  }, [setCommandPaletteOpen]);

  return (
    <div style={{ height: '100vh', display: 'flex', backgroundColor: '#f5f5f5' }}>
      <CommandPalette />

      {/* Left Column - Outline Panel (DB-backed) */}
      <aside style={{ 
        width: '220px', 
        backgroundColor: '#e8d5e8', 
        borderRight: '1px solid #ccc',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px'
      }}>
        <OutlinePanel />
        <div style={{ marginTop: 12 }}>
          <button
            onClick={() => navigate('/codex')}
            style={{ width: '100%', fontSize: 12, padding: '6px 8px', border: '1px solid #bbb', borderRadius: 6, background: '#c4b5c4' }}
          >
            Open Codex
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top Navigation */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px', borderBottom: '1px solid #ccc', backgroundColor: 'white' }}>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 'normal' }}>Spring - The novel creator</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => navigate('/graph')} style={{ padding: '4px 8px', fontSize: 12, backgroundColor: '#f0f0f0', border: '1px solid #ccc', borderRadius: 4 }}>Graph</button>
            <button onClick={() => navigate('/timeline')} style={{ padding: '4px 8px', fontSize: 12, backgroundColor: '#f0f0f0', border: '1px solid #ccc', borderRadius: 4 }}>Timeline</button>
            <button onClick={() => navigate('/outline')} style={{ padding: '4px 8px', fontSize: 12, backgroundColor: '#f0f0f0', border: '1px solid #ccc', borderRadius: 4 }}>Tree</button>
            <button onClick={() => navigate('/editor')} style={{ padding: '4px 8px', fontSize: 12, backgroundColor: '#f0f0f0', border: '1px solid #ccc', borderRadius: 4 }}>Editor</button>
          </div>
        </div>

        <div style={{ flex: 1, backgroundColor: '#e8e8e8' }}>
          <Outlet />
        </div>
      </main>

      {/* Right Sidecar - Inspector / TODO / Snippets */}
      <aside style={{ width: '320px', borderLeft: '1px solid #ccc', backgroundColor: 'white' }}>
        <Sidecar />
      </aside>
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

