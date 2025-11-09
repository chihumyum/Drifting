import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, Outlet, useLocation } from 'react-router-dom';
import { NodeEditorView } from './views/NodeEditorView';
import { ElementEditorView } from './views/ElementEditorView';
import { CategoryEditorView } from './views/CategoryEditorView';
import { ThreadEditorView } from './views/ThreadEditorView';
import { LoginPage } from './views/LoginPage';
import { RegisterPage } from './views/RegisterPage';
import { ProtectedRoute, PublicOnlyRoute } from './components/ProtectedRoute';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { ElementPanel } from './components/ElementPanel';
import { AppSidebar } from './components/AppSidebar';
import { TimelineChapters } from './components/TimelineChapters';
import { BackButton } from './components/BackButton';
import { DEFAULT_PROJECT } from './schema/table';
import { SettingsModal } from './components/modals/SettingsModal';
import { initAccentColor } from './lib/theme';
import { useAppStore } from './store';
import { SyncStatusHUD } from './components/sync/SyncStatusHUD';


function Layout() {
  const location = useLocation();
  const isEditorRoute = location.pathname.includes('/editor');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const timelineHeight = useAppStore((state) => state.timelineHeight);
  
  useEffect(() => {
    // Initialize theme
    initAccentColor();
    
    initDatabase(DEFAULT_PROJECT.id).then(() => {
      events.emit('db:ready');
    }).catch(error => {
      console.error('Failed to initialize database:', error);
      events.emit('db:error', { error: error.message });
    });
  }, []);

  useEffect(() => {
    // Listen for settings open event
    const handleOpenSettings = () => setIsSettingsOpen(true);
    events.on('settings:open', handleOpenSettings);
    return () => {
      events.off('settings:open', handleOpenSettings);
    };
  }, []);

  return (
    <div style={{ height: '100vh', overflow: 'hidden', background: 'rgba(251, 249, 243, 1)' }}>
      <div
        style={{
          height: `calc(100vh - ${timelineHeight}px)`, // 动态计算，根据 timeline 实际高度
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          overflow: 'hidden',
        }}
      >
        {/* Left Sidebar - Combined App Menu + Element Panel */}
        <div
          className="bg-paper-light border-r border-accent-border-light"
          style={{
            height: '100%', // ⭐ 关键！必须设置高度才能让内部 flex 正常工作
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid rgba(213, 213, 213, 0.3)',
            position: 'relative',
            overflow: 'visible', // Allow tabs to extend outside
          }}
        >
          {/* App Menu Section - Fixed height */}
          <div style={{ height: 120, flexShrink: 0 }}>
            <AppSidebar />
          </div>

          {/* Element Panel Section - Remaining space */}
          <div style={{ 
            flex: 1,
            minHeight: 0,
            borderTop: '1px solid rgba(145, 145, 145, 0.25)',
            position: 'relative',
            overflow: 'visible', // Allow tabs to protrude
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
          <BackButton />
          <Outlet />
        </main>
      </div>

      {/* Timeline Chapters - Fixed at bottom, full width */}
      <TimelineChapters />

      {/* Settings Modal */}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      <SyncStatusHUD />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Public Routes - Login/Register */}
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnlyRoute>
            <RegisterPage />
          </PublicOnlyRoute>
        }
      />

      {/* Protected Routes - Main App */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="editor" element={<Navigate to="/" replace />} />
        <Route path="editor/:nodeId" element={<NodeEditorView />} />
        <Route path="editor/thread/:threadId" element={<ThreadEditorView />} />
        <Route path="element/:elementId" element={<ElementEditorView />} />
        <Route path="category/:categoryName" element={<CategoryEditorView />} />
      </Route>
    </Routes>
  );
}
