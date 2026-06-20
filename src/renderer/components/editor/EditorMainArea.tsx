import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import {
  useProjectTabs,
  useUiStore,
  tabKey,
  type LeafTab,
  type SplitTab,
} from '../../store/ui-store';
import { NodeEditorView } from '../../views/NodeEditorView';
import { StorylineEditorView } from '../../views/StorylineEditorView';
import { ElementEditorView } from '../../views/ElementEditorView';
import { CategoryEditorView } from '../../views/CategoryEditorView';
import { AllChaptersEditorView } from '../../views/AllChaptersEditorView';
import { ProjectDashboard } from '../../views/ProjectDashboard';
import { pruneEditorSelectionMemory } from '../../lib/editor-selection-memory';

// EditorMainArea sits where <Outlet /> used to be. Its job is to decide
// whether the editor surface should render a single matched route element
// (the legacy single-pane behavior) or a side-by-side split.
//
// Single-pane:
//   The active top-level tab is a leaf (or there's no active tab — e.g. the
//   project dashboard or the all-chapters editor). React Router takes over:
//   we render <Outlet />, which mounts <EditorShell><SomeView/></EditorShell>
//   per the matched route. Behaviour is identical to before the split-pane
//   work.
//
// Split-pane:
//   The active top-level tab is a SplitTab. Outlet is NOT rendered (so the
//   matched route's element doesn't mount); instead each side is rendered
//   directly via PaneRenderer with an idOverride prop so the views know
//   which entity to load. A draggable divider between the panes drives the
//   stored splitRatio.
//
// Drag-to-split:
//   The whole surface watches drags carrying our `application/x-drifting-tab`
//   payload. When a tab is dragged over the right (or left) third, an
//   overlay hints the split target; dropping there calls splitActiveWith.
//   Dragging within the bar without crossing into the editor area just
//   reorders tabs (handled in TopTimeline).
export function EditorMainArea() {
  const { projectId, openEntity, navigateToHome } = useProjectNavigation();
  const { openTabs, activeTabKey } = useProjectTabs(projectId);
  const setSplitFocus = useUiStore((s) => s.setSplitFocus);
  const setSplitRatio = useUiStore((s) => s.setSplitRatio);
  const splitActiveWith = useUiStore((s) => s.splitActiveWith);

  const activeTab = openTabs.find((t) => tabKey(t) === activeTabKey) ?? null;
  const isSplit = activeTab?.kind === 'split';
  const split = isSplit ? (activeTab as SplitTab) : null;
  const hasNoTabs = openTabs.length === 0;

  useEffect(() => {
    if (!projectId) return;
    pruneEditorSelectionMemory(projectId, openTabs);
  }, [projectId, openTabs]);

  // Drag-to-split overlay state. `dropSide` is null when no tab drag is in
  // progress over the surface, otherwise indicates which half is hot.
  const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      // Only react to drags that carry the tab payload — we don't want to
      // hijack text/file drops the editor might want.
      if (!event.dataTransfer.types.includes('application/x-drifting-tab')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const el = surfaceRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = event.clientX - rect.left;
      // Reserve the central 40% for "no split" — drop in the middle either
      // does nothing (when no active tab) or just activates the dragged tab.
      // The outer thirds trigger split.
      if (x < rect.width * 0.33) setDropSide('left');
      else if (x > rect.width * 0.67) setDropSide('right');
      else setDropSide(null);
    },
    [],
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    // Only clear if the drag truly left the surface (not just moved to a
    // child). relatedTarget being outside the surface signals true leave.
    const el = surfaceRef.current;
    if (!el) return;
    if (el.contains(event.relatedTarget as Node | null)) return;
    setDropSide(null);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes('application/x-drifting-tab')) return;
      event.preventDefault();
      const source = event.dataTransfer.getData('application/x-drifting-tab');
      const side = dropSide;
      setDropSide(null);
      if (!projectId || !source || !side) return;
      splitActiveWith(projectId, { fromKey: source }, side);
    },
    [projectId, dropSide, splitActiveWith],
  );

  return (
    <div
      ref={surfaceRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ position: 'relative', height: '100%', width: '100%' }}
    >
      {isSplit && split ? (
        <SplitView
          split={split}
          projectId={projectId ?? ''}
          onSetFocus={(side) => {
            if (!projectId) return;
            setSplitFocus(projectId, split.id, side);
            // Reflect focused side in URL too (keeps sidebar / timeline
            // tracking the focused leaf).
            const leaf = side === 'left' ? split.left : split.right;
            openEntity({ entityType: leaf.entityType, id: leaf.id });
          }}
          onSetRatio={(ratio) => {
            if (!projectId) return;
            setSplitRatio(projectId, split.id, ratio);
          }}
        />
      ) : hasNoTabs ? (
        // No tabs open at all → blank editor surface with a one-line hint.
        // Routes still match (Outlet would render the route's view), but
        // displaying nothing here is the intended UX per the new "no tabs
        // means empty" rule — dashboard / all-chapters are their own tabs
        // now and won't auto-mount when the user has closed everything.
        <EmptyEditorState onOpenDashboard={navigateToHome} />
      ) : (
        // Legacy single-pane path — Outlet renders the matched route element.
        <div style={{ height: '100%', width: '100%' }}>
          <Outlet />
        </div>
      )}

      {dropSide && <DropOverlay side={dropSide} />}
    </div>
  );
}

interface SplitViewProps {
  split: SplitTab;
  projectId: string;
  onSetFocus: (side: 'left' | 'right') => void;
  onSetRatio: (ratio: number) => void;
}

function SplitView({ split, projectId, onSetFocus, onSetRatio }: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // Mouse-driven divider drag. We use ref-tracked container width so the
  // listener doesn't capture stale state from a closure.
  const onDividerMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      draggingRef.current = true;
      const onMove = (e: MouseEvent) => {
        if (!draggingRef.current) return;
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0) return;
        const x = e.clientX - rect.left;
        onSetRatio(x / rect.width);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [onSetRatio],
  );

  const leftPct = `${Math.round(split.splitRatio * 100)}%`;
  const rightPct = `${100 - Math.round(split.splitRatio * 100)}%`;

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', height: '100%', width: '100%', minWidth: 0 }}
    >
      <PaneWrapper
        isFocused={split.focused === 'left'}
        width={leftPct}
        onFocusRequest={() => onSetFocus('left')}
      >
        <PaneRenderer leaf={split.left} projectId={projectId} />
      </PaneWrapper>
      <PaneDivider onMouseDown={onDividerMouseDown} />
      <PaneWrapper
        isFocused={split.focused === 'right'}
        width={rightPct}
        onFocusRequest={() => onSetFocus('right')}
      >
        <PaneRenderer leaf={split.right} projectId={projectId} />
      </PaneWrapper>
    </div>
  );
}

function PaneWrapper({
  isFocused,
  width,
  onFocusRequest,
  children,
}: {
  isFocused: boolean;
  width: string;
  onFocusRequest: () => void;
  children: ReactNode;
}) {
  // mousedown rather than click so focus updates the moment the user starts
  // interacting (matches VS Code: clicking inside an editor immediately
  // focuses that pane before any text selection actions).
  return (
    <div
      onMouseDownCapture={onFocusRequest}
      style={{
        width,
        minWidth: 0,
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        // Subtle inset shadow on the focused side so the user can see at a
        // glance which pane keystrokes / commands will act on.
        boxShadow: isFocused
          ? 'inset 0 2px 0 hsl(var(--accent) / 0.55)'
          : 'inset 0 2px 0 transparent',
        transition: 'box-shadow 0.18s ease',
      }}
    >
      {children}
    </div>
  );
}

function PaneDivider({ onMouseDown }: { onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="separator"
      aria-orientation="vertical"
      style={{
        width: 5,
        cursor: 'col-resize',
        background: hover ? 'hsl(var(--accent) / 0.25)' : 'hsl(var(--rule))',
        flexShrink: 0,
        transition: 'background 0.15s ease',
      }}
    />
  );
}

function PaneRenderer({ leaf, projectId }: { leaf: LeafTab; projectId: string }) {
  // Dispatch on entityType — each entity view accepts an idOverride prop
  // for the case when it's rendered outside the matched-route Outlet path.
  // projectId is read from useParams inside the views (the parent route
  // /project/:projectId always matches), so we don't need to thread it.
  // Singleton views (dashboard / all-chapters) have no per-entity id, so
  // they take no override.
  void projectId;
  switch (leaf.entityType) {
    case 'node':
      return <NodeEditorView key={leaf.id} nodeIdOverride={leaf.id} />;
    case 'storyline':
      return <StorylineEditorView key={leaf.id} storylineIdOverride={leaf.id} />;
    case 'element':
      return <ElementEditorView key={leaf.id} elementIdOverride={leaf.id} />;
    case 'category':
      return <CategoryEditorView key={leaf.id} categoryIdOverride={leaf.id} />;
    case 'dashboard':
      return <ProjectDashboard />;
    case 'all-chapters':
      return <AllChaptersEditorView />;
  }
}

function EmptyEditorState({ onOpenDashboard }: { onOpenDashboard: () => void }) {
  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
      }}
    >
      <button
        type="button"
        onClick={onOpenDashboard}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontSize: 13,
          color: 'hsl(var(--accent))',
        }}
      >
        打开项目主页
      </button>
      <div style={{ fontSize: 12, color: 'hsl(var(--ink-5))' }}>是时候开始写作了</div>
    </div>
  );
}

function DropOverlay({ side }: { side: 'left' | 'right' }) {
  // Visual hint shown during a drag-to-split. Half-screen tinted rectangle on
  // the side that would receive the drop, with a centered glyph.
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: side === 'left' ? 0 : '50%',
        right: side === 'left' ? '50%' : 0,
        background: 'hsl(var(--accent) / 0.10)',
        border: '2px dashed hsl(var(--accent) / 0.45)',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 5,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'hsl(var(--accent))',
          background: 'hsl(var(--paper) / 0.92)',
          padding: '6px 14px',
          borderRadius: 4,
          boxShadow: '0 1px 4px hsl(var(--ink-1) / 0.15)',
        }}
      >
        在{side === 'left' ? '左' : '右'}侧打开
      </div>
    </div>
  );
}
