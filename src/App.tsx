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
    <div style={{ height: '100vh', overflow: 'hidden', background: 'rgba(251, 249, 243, 1)' }}>
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
          className="bg-mild"
          style={{
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid rgba(213, 213, 213, 0.3)',
          }}
        >
          {/* App Menu Section - Top 1/4 */}
          <div >
            <AppSidebar />
          </div>

          {/* Element Panel Section - Bottom 3/4 */}
          <div style={{ 
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            borderTop: '1px solid rgba(145, 145, 145, 0.25)',
          }}>
            <ElementPanel />
          </div>
        </div>

        {/* Main Content Area */}
        <main
          style={{
            position: 'relative',
            overflow: 'hidden',
            background: isEditorRoute ? 'rgba(251, 249, 243, 1)' : 'transparent',
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
