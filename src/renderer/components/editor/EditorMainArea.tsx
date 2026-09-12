import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import {
  useProjectTabs,
  useUiStore,
  tabKey,
  type AnyTab,
  type LeafTab,
  type CreateTab,
  type SplitTab,
} from '../../store/ui-store';
import { NodeEditorView } from '../../views/NodeEditorView';
import { StorylineEditorView } from '../../views/StorylineEditorView';
import { ElementEditorView } from '../../views/ElementEditorView';
import { CategoryEditorView } from '../../views/CategoryEditorView';
import { AllChaptersEditorView } from '../../views/AllChaptersEditorView';
import { ProjectDashboard } from '../../views/ProjectDashboard';
import { pruneEditorSelectionMemory } from '../../lib/editor-selection-memory';
import { isStructuralEntityKind } from '../../domain/entity-kinds';
import { EntityHoverCard } from '../../features/entities/hover/EntityHoverCard';
import {
  useHoverPreview,
  type EntityHoverTarget,
} from '../../features/entities/hover/entity-hover-card-model';
import { DesktopUniversalCreateView } from '../../shells/desktop/entity-create/DesktopUniversalCreateView';
import {
  EditorSurfaceLifecycleProvider,
  ImmediateEditorSurfaceReady,
} from './EditorSurfaceLifecycle';

const PROJECT_HOME_SURFACE_KEY = 'project-home';

interface WorkspaceSurfaceDescriptor {
  revisionKey: string;
  tab: AnyTab | null;
}

function surfaceRevisionKey(tab: AnyTab): string {
  if (tab.kind === 'split') {
    return `${tabKey(tab)}|left=${tabKey(tab.left)}|right=${tabKey(tab.right)}`;
  }
  return tabKey(tab);
}

// EditorMainArea is the desktop editor-session owner. Every open top-level tab
// remains mounted in an absolute surface; switching tabs changes visibility,
// not the React/TipTap/Yjs lifetime. A newly-created/replaced surface mounts
// behind the currently committed one and is revealed only after its canonical
// editor reports ready, so Router/store timing can never expose an empty frame.
//
// Drag-to-split:
//   The whole surface watches drags carrying our `application/x-drifting-tab`
//   payload. When a tab is dragged over the right (or left) third, an
//   overlay hints the split target; dropping there calls splitActiveWith.
//   Dragging within the bar without crossing into the editor area just
//   reorders tabs (handled in TopTimeline).
export function EditorMainArea() {
  const { projectId, openEntity } = useProjectNavigation();
  const { openTabs, activeTabKey } = useProjectTabs(projectId);
  const setSplitFocus = useUiStore((s) => s.setSplitFocus);
  const setSplitRatio = useUiStore((s) => s.setSplitRatio);
  const splitActiveWith = useUiStore((s) => s.splitActiveWith);

  const activeTab = openTabs.find((t) => tabKey(t) === activeTabKey) ?? null;
  const createTab = activeTab?.kind === 'create' ? (activeTab as CreateTab) : null;
  const currentSurfaces = useMemo<WorkspaceSurfaceDescriptor[]>(
    () => [
      { revisionKey: PROJECT_HOME_SURFACE_KEY, tab: null },
      ...openTabs.map((tab) => ({ revisionKey: surfaceRevisionKey(tab), tab })),
    ],
    [openTabs],
  );
  const desiredRevisionKey = activeTab
    ? surfaceRevisionKey(activeTab)
    : PROJECT_HOME_SURFACE_KEY;
  const [committedSurface, setCommittedSurface] =
    useState<WorkspaceSurfaceDescriptor | null>(null);
  const committedRevisionKey = committedSurface?.revisionKey ?? null;

  const handleSurfaceReadyChange = useCallback(
    (descriptor: WorkspaceSurfaceDescriptor, ready: boolean, isDesired: boolean) => {
      if (ready && isDesired) setCommittedSurface(descriptor);
    },
    [],
  );

  const renderedSurfaces = useMemo(() => {
    const next = [...currentSurfaces];
    if (
      committedSurface &&
      !next.some((surface) => surface.revisionKey === committedSurface.revisionKey)
    ) {
      next.push(committedSurface);
    }
    return next;
  }, [committedSurface, currentSurfaces]);

  useEffect(() => {
    if (!projectId) return;
    pruneEditorSelectionMemory(projectId, openTabs);
  }, [projectId, openTabs]);

  // Drag-to-split overlay state. `dropSide` is null when no tab drag is in
  // progress over the surface, otherwise indicates which half is hot.
  const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const {
    preview: entityHoverPreview,
    onEnter: entityHoverEnter,
    onLeave: entityHoverLeave,
  } = useHoverPreview<EntityHoverTarget>();

  const handleEntityLinkMouseOver = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (document.documentElement.getAttribute('data-entity-link-interactive') === 'off') return;
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const link = origin.closest<HTMLElement>('.entity-link');
      if (!link || !surfaceRef.current?.contains(link)) return;
      const related = event.relatedTarget;
      if (related instanceof Node && link.contains(related)) return;
      const kind = link.getAttribute('data-target-kind') ?? 'element';
      const id = link.getAttribute('data-target-id');
      if (!id || !isStructuralEntityKind(kind)) return;
      entityHoverEnter({ kind, id }, link);
    },
    [entityHoverEnter],
  );

  const handleEntityLinkMouseOut = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const link = origin.closest<HTMLElement>('.entity-link');
      if (!link) return;
      const related = event.relatedTarget;
      if (related instanceof Node && link.contains(related)) return;
      entityHoverLeave();
    },
    [entityHoverLeave],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      // Only react to drags that carry the tab payload — we don't want to
      // hijack text/file drops the editor might want.
      if (!event.dataTransfer.types.includes('application/x-drifting-tab')) return;
      if (createTab || !activeTab) {
        setDropSide(null);
        return;
      }
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
    [activeTab, createTab],
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
      onMouseOver={handleEntityLinkMouseOver}
      onMouseOut={handleEntityLinkMouseOut}
      style={{ position: 'relative', height: '100%', width: '100%' }}
    >
      {renderedSurfaces.map((surface) => (
        <WorkspaceSurface
          key={surface.revisionKey}
          descriptor={surface}
          projectId={projectId ?? ''}
          isVisible={surface.revisionKey === committedRevisionKey}
          isDesired={surface.revisionKey === desiredRevisionKey}
          isInteractive={
            surface.revisionKey === committedRevisionKey &&
            surface.revisionKey === desiredRevisionKey
          }
          onReadyChange={handleSurfaceReadyChange}
          onSetSplitFocus={(split, side) => {
            if (!projectId) return;
            setSplitFocus(projectId, split.id, side);
            const leaf = side === 'left' ? split.left : split.right;
            openEntity({ entityType: leaf.entityType, id: leaf.id });
          }}
          onSetSplitRatio={(split, ratio) => {
            if (!projectId) return;
            setSplitRatio(projectId, split.id, ratio);
          }}
        />
      ))}

      {committedRevisionKey === null && <EditorStageLoadingSurface />}

      {entityHoverPreview && (
        <EntityHoverCard
          target={entityHoverPreview.data}
          anchor={entityHoverPreview.anchor}
          placement="bottom-start"
        />
      )}

      {dropSide && <DropOverlay side={dropSide} />}
    </div>
  );
}

function WorkspaceSurface({
  descriptor,
  projectId,
  isVisible,
  isDesired,
  isInteractive,
  onReadyChange,
  onSetSplitFocus,
  onSetSplitRatio,
}: {
  descriptor: WorkspaceSurfaceDescriptor;
  projectId: string;
  isVisible: boolean;
  isDesired: boolean;
  isInteractive: boolean;
  onReadyChange(
    descriptor: WorkspaceSurfaceDescriptor,
    ready: boolean,
    isDesired: boolean,
  ): void;
  onSetSplitFocus(split: SplitTab, side: 'left' | 'right'): void;
  onSetSplitRatio(split: SplitTab, ratio: number): void;
}) {
  const { revisionKey, tab } = descriptor;
  const reportReady = useCallback(
    (ready: boolean) => onReadyChange({ revisionKey, tab }, ready, isDesired),
    [isDesired, onReadyChange, revisionKey, tab],
  );

  let content: ReactNode;
  if (!tab) {
    content = (
      <EditorSurfaceLifecycleProvider
        isVisible={isVisible}
        isPreparing={isDesired}
        isCommandActive={isInteractive}
        onReadyChange={reportReady}
      >
        <ImmediateEditorSurfaceReady>
          <ProjectDashboard />
        </ImmediateEditorSurfaceReady>
      </EditorSurfaceLifecycleProvider>
    );
  } else if (tab.kind === 'create') {
    content = (
      <EditorSurfaceLifecycleProvider
        isVisible={isVisible}
        isPreparing={isDesired}
        isCommandActive={isInteractive}
        onReadyChange={reportReady}
      >
        <ImmediateEditorSurfaceReady>
          <DesktopUniversalCreateView tab={tab} />
        </ImmediateEditorSurfaceReady>
      </EditorSurfaceLifecycleProvider>
    );
  } else if (tab.kind === 'split') {
    content = (
      <SplitView
        split={tab}
        projectId={projectId}
        isSurfaceVisible={isVisible}
        isSurfacePreparing={isDesired}
        isSurfaceInteractive={isInteractive}
        onReadyChange={reportReady}
        onSetFocus={(side) => onSetSplitFocus(tab, side)}
        onSetRatio={(ratio) => onSetSplitRatio(tab, ratio)}
      />
    );
  } else {
    content = (
      <EditorSurfaceLifecycleProvider
        isVisible={isVisible}
        isPreparing={isDesired}
        isCommandActive={isInteractive}
        onReadyChange={reportReady}
      >
        <PaneRenderer leaf={tab} projectId={projectId} />
      </EditorSurfaceLifecycleProvider>
    );
  }

  return (
    <div
      data-editor-surface={revisionKey}
      data-editor-surface-visible={isVisible ? 'true' : 'false'}
      aria-hidden={!isVisible}
      inert={!isInteractive}
      style={{
        position: 'absolute',
        inset: 0,
        minWidth: 0,
        overflow: 'hidden',
        visibility: isVisible ? 'visible' : 'hidden',
        pointerEvents: isInteractive ? 'auto' : 'none',
        zIndex: isVisible ? 1 : 0,
      }}
    >
      {content}
    </div>
  );
}

function EditorStageLoadingSurface() {
  return (
    <div
      aria-hidden
      data-editor-stage-loading
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        background: 'hsl(var(--paper))',
        pointerEvents: 'none',
      }}
    />
  );
}

interface SplitViewProps {
  split: SplitTab;
  projectId: string;
  isSurfaceVisible: boolean;
  isSurfacePreparing: boolean;
  isSurfaceInteractive: boolean;
  onReadyChange(ready: boolean): void;
  onSetFocus: (side: 'left' | 'right') => void;
  onSetRatio: (ratio: number) => void;
}

function SplitView({
  split,
  projectId,
  isSurfaceVisible,
  isSurfacePreparing,
  isSurfaceInteractive,
  onReadyChange,
  onSetFocus,
  onSetRatio,
}: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [leftReady, setLeftReady] = useState(false);
  const [rightReady, setRightReady] = useState(false);

  useLayoutEffect(() => {
    onReadyChange(leftReady && rightReady);
    return () => onReadyChange(false);
  }, [leftReady, onReadyChange, rightReady]);

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
        <EditorSurfaceLifecycleProvider
          isVisible={isSurfaceVisible}
          isPreparing={isSurfacePreparing}
          isCommandActive={isSurfaceInteractive && split.focused === 'left'}
          onReadyChange={setLeftReady}
        >
          <PaneRenderer leaf={split.left} projectId={projectId} />
        </EditorSurfaceLifecycleProvider>
      </PaneWrapper>
      <PaneDivider onMouseDown={onDividerMouseDown} />
      <PaneWrapper
        isFocused={split.focused === 'right'}
        width={rightPct}
        onFocusRequest={() => onSetFocus('right')}
      >
        <EditorSurfaceLifecycleProvider
          isVisible={isSurfaceVisible}
          isPreparing={isSurfacePreparing}
          isCommandActive={isSurfaceInteractive && split.focused === 'right'}
          onReadyChange={setRightReady}
        >
          <PaneRenderer leaf={split.right} projectId={projectId} />
        </EditorSurfaceLifecycleProvider>
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
  // because the desktop stage, not the matched child-route element, owns it.
  // projectId is read from useParams inside the views (the parent route
  // /project/:projectId always matches), so we don't need to thread it.
  // All Chapters has no per-entity id, so it takes no override.
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
    case 'all-chapters':
      return <AllChaptersEditorView />;
  }
}

function DropOverlay({ side }: { side: 'left' | 'right' }) {
  const { t } = useTranslation();
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
        {t('editorMainArea.openOnSide', {
          side: side === 'left' ? t('editorMainArea.side.left') : t('editorMainArea.side.right'),
        })}
      </div>
    </div>
  );
}
