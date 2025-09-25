import { useCallback, useEffect, useRef, useState } from 'react';
import { Route, Routes, Outlet, useLocation } from 'react-router-dom';
import { EditorView } from './views/Editor/EditorView';
import { EntityView } from './views/EntityView';
import { useAppStore } from './store';
import { initDatabase } from './lib/db';
import { events } from './lib/events';
import { ChapterNavigator } from './components/ChapterNavigator';
import { EntityPanel, type EntityPanelActions } from './components/EntityPanel';
import { Plus } from 'lucide-react';

function Layout() {
  const {
  } = useAppStore();
  const location = useLocation();
  const isEditorRoute = location.pathname.includes('/editor');
  const [novelName, setNovelName] = useState('My Novel');
  const [entityExpanded, setEntityExpanded] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const [entityActions, setEntityActions] = useState<EntityPanelActions | null>(null);

  useEffect(() => {
    initDatabase().then(() => {
      events.emit('db:ready');
    }).catch(error => {
      console.error('Failed to initialize database:', error);
      events.emit('db:error', { error: error.message });
    });
  }, []);


  const clearTimers = () => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  };

  const scheduleExpand = useCallback(() => {
    if (entityExpanded) return;
    clearTimers();
    hoverTimerRef.current = window.setTimeout(() => setEntityExpanded(true), 220);
  }, [entityExpanded]);

  const scheduleCollapse = useCallback(() => {
    clearTimers();
    collapseTimerRef.current = window.setTimeout(() => setEntityExpanded(false), 400);
  }, []);

  useEffect(() => () => clearTimers(), []);

  const handleRegisterActions = useCallback((actions: EntityPanelActions) => {
    setEntityActions(actions);
  }, []);

  // 下面日后改为新建的同时弹modal
  const handleQuickCreateEntity = useCallback(() => {
    if (!entityActions) return;
    void entityActions.createEntity();
    setEntityExpanded(true);
  }, [entityActions]);

  const handleQuickCreateCategory = useCallback(() => {
    if (!entityActions) return;
    const value = prompt('新的类别名称', '');
    if (!value) return;
    void entityActions.createCategory(value);
    setEntityExpanded(true);
  }, [entityActions]);


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
            <EntityPanel onRegisterActions={handleRegisterActions} />
          </div>

          {!entityExpanded && (
            <div
              onMouseEnter={scheduleExpand}
              style={{
                position: 'absolute',
                top: 120,
                left: 258,
                width: 28,
                height: 140,
                borderRadius: 14,
                background: 'rgba(255,255,255,0.65)',
                boxShadow: '0 16px 32px rgba(40,32,70,0.18)',
                cursor: 'pointer',
                zIndex: 5,
              }}
            />
          )}

          {!entityExpanded && (
            <div
              style={{
                position: 'absolute',
                top: 24,
                left: 300,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                pointerEvents: 'auto',
                zIndex: 6,
              }}
            >
              <QuickActionButton label="新建实体" onClick={handleQuickCreateEntity} />
              <QuickActionButton label="新建类别" onClick={handleQuickCreateCategory} />
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<EntityView />} />
        {/* <Route path="graph" element={<GraphView />} /> */}
        <Route path="editor" element={<EditorView />} />
        <Route path="codex" element={<EntityView />} />
      </Route>
    </Routes>
  )
}


function QuickActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 'none',
        borderRadius: 16,
        padding: '8px 14px',
        fontSize: 12,
        fontWeight: 600,
        background: '#ffffff',
        color: '#423852',
        boxShadow: '0 12px 28px rgba(40, 32, 70, 0.18)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        transition: 'transform 0.2s ease',
      }}
      onMouseEnter={(event) => {
        (event.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(event) => {
        (event.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
      }}
    >
      <Plus size={13} />
      {label}
    </button>
  );
}
