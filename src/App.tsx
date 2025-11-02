import { useCallback, useEffect, useRef, useState } from 'react';
import { Route, Routes, Outlet, useLocation } from 'react-router-dom';
import { EditorView } from './views/Editor/EditorView';
import { ElementView } from './views/ElementView';
import { useAppStore } from './store';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { ChapterNavigator } from './components/ChapterNavigator';
import { ElementPanel } from './components/ElementPanel';
import { DEFAULT_PROJECT } from './schema/table';


function Layout() {

  const location = useLocation();
  const isEditorRoute = location.pathname.includes('/editor');
  useEffect(() => {
    initDatabase(DEFAULT_PROJECT.id).then(() => {
      events.emit('db:ready');
    }).catch(error => {
      console.error('Failed to initialize database:', error);
      events.emit('db:error', { error: error.message });
    });
  }, []);
  return (
    <div>
      <div
        style={{
          height: '100vh',
          display: 'grid',
          gridTemplateColumns: isEditorRoute
            ? '320px 1fr 160px'
            : '320px 1fr 120px',
          transition: 'grid-template-columns 0.3s ease',
          backgroundColor: '#f4f2f6',
          overflow: 'hidden'
        }}
      >

        <div
          style={{
            padding: '22px 16px',
            overflow: 'visible',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 20,
            background: 'transparent',
          }}
        >
          <div
            style={{
              width: 280,
              borderRadius: 24,
              background: '#ffffff',
              boxShadow: '0 24px 48px rgba(40, 32, 70, 0.12)',
              overflow: 'hidden',
              position: 'relative',
              zIndex: 3,
            }}
          >
            <ChapterNavigator />
          </div>

          <div style={{ position: 'relative', width: 280, flex: 1, minHeight: 0, overflow: 'visible' }}>
            <ElementPanel />
          </div>

        </div>

        {/* <main
          style={{
            position: 'relative',
            overflow: 'hidden',
            background: 'transparent',
          }}
        >
          <Outlet />
        </main> */}

        <aside
          style={{
            borderLeft: '1px solid rgba(220,210,230,0.5)',
            background: isEditorRoute ? 'rgba(255,255,255,0.6)' : 'transparent'
          }}
        />
      </div>

    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<ElementView />} />
        {/* <Route path="graph" element={<GraphView />} /> */}
        <Route path="editor" element={<EditorView />} />
        <Route path="elements" element={<ElementView />} />
      </Route>
    </Routes>
  )
}
