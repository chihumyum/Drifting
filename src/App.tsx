import { useEffect } from 'react';
import { Navigate, Route, Routes, Outlet, useLocation } from 'react-router-dom';
import { EditorView } from './views/Editor/EditorView';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { ElementPanel } from './components/ElementPanel';
import { AppSidebar } from './components/AppSidebar';
import { TimelineChapters } from './components/TimelineChapters';
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
    <div style={{ height: '100vh', overflow: 'hidden', background: '#f4f2f6' }}>
      <div
        style={{
          height: 'calc(100vh - 120px)', // Leave space for timeline at bottom
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          overflow: 'hidden',
        }}
      >
        {/* Left Sidebar - Combined App Menu + Element Panel */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            background: 'linear-gradient(180deg, rgba(248, 246, 252, 0.98) 0%, rgba(252, 250, 255, 0.98) 100%)',
            borderRight: '1px solid rgba(200, 190, 220, 0.3)',
          }}
        >
          {/* App Menu Section - Top 1/4 */}
          <div style={{ height: '25%', minHeight: 200 }}>
            <AppSidebar />
          </div>

          {/* Element Panel Section - Bottom 3/4 */}
          <div style={{ 
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            borderTop: '1px solid rgba(200, 190, 220, 0.25)',
          }}>
            <ElementPanel />
          </div>
        </div>

        {/* Main Content Area */}
        <main
          style={{
            position: 'relative',
            overflow: 'hidden',
            background: isEditorRoute ? 'rgba(245, 243, 250, 0.5)' : 'transparent',
          }}
        >
          <Outlet />
        </main>
      </div>

      {/* Timeline Chapters - Fixed at bottom, full width */}
      <TimelineChapters />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route path="editor" element={<Navigate to="/" replace />} />
        <Route path="editor/:nodeId" element={<EditorView />} />
      </Route>
    </Routes>
  )
}
