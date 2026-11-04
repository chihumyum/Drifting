import { editorSurfaceContentVisibility } from '../../features/editor/surface-rendering';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingStatus } from '../ui/LoadingStatus';

import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import {
  useProjectTabs,
  useUiStore,
  tabKey,
  type AnyTab,
  type LeafTab,
  type SplitTab,
} from '../../store/ui-store';
import { NodeEditorView } from '../../views/NodeEditorView';
import { StorylineEditorView } from '../../views/StorylineEditorView';
import { ElementEditorView } from '../../views/ElementEditorView';
import { CategoryEditorView } from '../../views/CategoryEditorView';
import { MaterialEditorView } from '../../views/MaterialEditorView';
import { AllChaptersEditorView } from '../../views/AllChaptersEditorView';
import { ProjectDashboard } from '../../views/ProjectDashboard';
import { pruneEditorSelectionMemory } from '../../lib/editor-selection-memory';
import { isStructuralEntityKind } from '../../domain/entity-kinds';
import { EntityHoverCard } from '../../features/entities/hover/EntityHoverCard';
import {
  useHoverPreview,
  type EntityHoverTarget,
} from '../../features/entities/hover/entity-hover-card-model';
import {
  EditorSurfaceLifecycleProvider,
  ImmediateEditorSurfaceReady,
} from './EditorSurfaceLifecycle';
import { TrailingEditorPaneContext } from './editor-corner';
import { TextInputLookupStop } from './TextInputLookupStop';
import { announceEditorStageReady } from './editor-stage-ready';
import { commitSurface, stopPageTurn, turnPage, type PageTurnStage } from './editor-page-turn';
import { editorStageWaiting, setEditorStageWaiting } from './editor-stage-waiting';
import { LOADING_DELAY_MS } from '../../lib/motion';

const PROJECT_HOME_SURFACE_KEY = 'project-home';
/** A link's card covers at most this much of the page; the rest scrolls inside it. */
const PROSE_HOVER_CARD_MAX_HEIGHT = 480;

interface WorkspaceSurfaceDescriptor {
  revisionKey: string;
  tab: AnyTab | null;
}

type WorkspaceStage = PageTurnStage<WorkspaceSurfaceDescriptor>;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function surfaceRevisionKey(tab: AnyTab): string {
  if (tab.kind === 'split') {
    return `${tabKey(tab)}|left=${tabKey(tab.left)}|right=${tabKey(tab.right)}`;
  }
  return tabKey(tab);
}

// EditorMainArea is the desktop editor-session owner. Every open top-level tab
// that has been in front since the book opened remains mounted in an absolute
// surface; switching tabs changes visibility, not the React/TipTap/Yjs
// lifetime. A tab not yet visited mounts when it is first wanted, so opening a
// book loads only the page in front. A newly-created/replaced/first-visited
// surface mounts behind the currently committed one and is revealed only after
// its canonical editor reports ready, so Router/store timing can never expose
// an empty frame. Once the book is in view, every change of the surface in
// front turns the page (editor-page-turn.ts), and a page that takes longer
// than the loading delay to be ready lets the dock tab asked for drift its
// glass until it arrives (editor-stage-waiting.ts).
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
  const [stage, setStage] = useState<WorkspaceStage>({ committed: null, leaving: null });
  const { committed: committedSurface, leaving: leavingSurface } = stage;
  const committedRevisionKey = committedSurface?.revisionKey ?? null;
  const leavingRevisionKey = leavingSurface?.revisionKey ?? null;
  const stageAnnounced = useRef(false);
  const [stageShown, setStageShown] = useState(false);

  const handleSurfaceReadyChange = useCallback(
    (descriptor: WorkspaceSurfaceDescriptor, ready: boolean, isDesired: boolean) => {
      if (!ready || !isDesired) return;
      const turn = stageAnnounced.current && !prefersReducedMotion();
      setStage((current) => commitSurface(current, descriptor, turn));
    },
    [],
  );

  // The first time the surface in front is the one wanted, the book is ready to
  // be seen. Checked a task later against the latest keys: opening a book
  // resumes its last tab in a parent's layout effect, after Project Home has
  // already committed, and that first match must not count.
  const stageKeys = useRef({ committed: committedRevisionKey, desired: desiredRevisionKey });
  useLayoutEffect(() => {
    stageKeys.current = { committed: committedRevisionKey, desired: desiredRevisionKey };
  }, [committedRevisionKey, desiredRevisionKey]);
  useEffect(() => {
    if (stageAnnounced.current || committedRevisionKey === null || committedRevisionKey !== desiredRevisionKey) {
      return undefined;
    }
    const timer = setTimeout(() => {
      const { committed, desired } = stageKeys.current;
      if (stageAnnounced.current || committed === null || committed !== desired) return;
      stageAnnounced.current = true;
      setStageShown(true);
      announceEditorStageReady();
    }, 0);
    return () => clearTimeout(timer);
  }, [committedRevisionKey, desiredRevisionKey]);

  // The page turn. Before the next paint, the surface just put in front
  // dissolves in over the one it replaced, which stays whole underneath and
  // is hidden once covered. A newer turn takes over from where the paper is.
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const turningKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const surfaceOf = (key: string | null) => {
      if (key === null) return null;
      for (const child of surfaceRef.current?.children ?? []) {
        if (child instanceof HTMLElement && child.dataset.editorSurface === key) return child;
      }
      return null;
    };
    const previous = turningKey.current;
    turningKey.current = leavingRevisionKey;
    // The page that was leaving is hidden now (or back in front, where the
    // new turn picks it up): any turn left on it lets go.
    if (previous !== null && previous !== leavingRevisionKey && previous !== committedRevisionKey) {
      stopPageTurn(surfaceOf(previous));
    }
    if (leavingRevisionKey === null || leavingRevisionKey === previous) return;
    const settle = () => setStage((current) =>
      current.leaving?.revisionKey === leavingRevisionKey ? { ...current, leaving: null } : current);
    const incoming = surfaceOf(committedRevisionKey);
    const outgoing = surfaceOf(leavingRevisionKey);
    if (!incoming || !outgoing) {
      settle();
      return;
    }
    turnPage(incoming, outgoing).finished.then(settle, () => undefined);
  }, [committedRevisionKey, leavingRevisionKey]);

  // A page that is not ready a loading delay after it was asked for: the dock
  // lets the tab asked for drift its glass until the page arrives. A wait
  // already showing moves to a newly asked-for tab rather than blinking out.
  useEffect(() => {
    if (!stageShown || committedRevisionKey === desiredRevisionKey || activeTabKey === null) {
      setEditorStageWaiting(null);
      return undefined;
    }
    if (editorStageWaiting() !== null) {
      setEditorStageWaiting(activeTabKey);
      return undefined;
    }
    const timer = setTimeout(() => setEditorStageWaiting(activeTabKey), LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [stageShown, committedRevisionKey, desiredRevisionKey, activeTabKey]);
  useEffect(() => () => setEditorStageWaiting(null), []);

  // The surfaces that have been wanted since the book opened; only these mount.
  const [visitedKeys, setVisitedKeys] = useState<ReadonlySet<string>>(() => new Set([desiredRevisionKey]));
  if (!visitedKeys.has(desiredRevisionKey)) setVisitedKeys(new Set(visitedKeys).add(desiredRevisionKey));

  const renderedSurfaces = useMemo(() => {
    const next = currentSurfaces.filter((surface) =>
      visitedKeys.has(surface.revisionKey) || surface.revisionKey === committedSurface?.revisionKey);
    if (
      committedSurface &&
      !next.some((surface) => surface.revisionKey === committedSurface.revisionKey)
    ) {
      next.push(committedSurface);
    }
    // A closed tab's page stays until its successor has covered it.
    if (leavingSurface && !next.some((surface) => surface.revisionKey === leavingSurface.revisionKey)) {
      next.push(leavingSurface);
    }
    return next;
  }, [committedSurface, leavingSurface, currentSurfaces, visitedKeys]);

  useEffect(() => {
    if (!projectId) return;
    // A removed committed surface stays mounted until its replacement is ready
    // and has turned the page over it. Its later detach can save selection
    // after the openTabs prune already ran; prune again once the handoff
    // retires that last owner.
    pruneEditorSelectionMemory(projectId, openTabs);
  }, [projectId, openTabs, committedRevisionKey, leavingRevisionKey]);

  // Drag-to-split overlay state. `dropSide` is null when no tab drag is in
  // progress over the surface, otherwise indicates which half is hot.
  const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null);
  const {
    preview: entityHoverPreview,
    onEnter: entityHoverEnter,
    onLeave: entityHoverLeave,
    dismiss: entityHoverDismiss,
    card: entityHoverCard,
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
      if (!activeTab) {
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
    [activeTab],
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

  const handleSetSplitFocus = useCallback((split: SplitTab, side: 'left' | 'right') => {
    if (!projectId) return;
    setSplitFocus(projectId, split.id, side);
    const leaf = side === 'left' ? split.left : split.right;
    openEntity({ entityType: leaf.entityType, id: leaf.id });
  }, [projectId, setSplitFocus, openEntity]);
  const handleSetSplitRatio = useCallback((split: SplitTab, ratio: number) => {
    if (projectId) setSplitRatio(projectId, split.id, ratio);
  }, [projectId, setSplitRatio]);

  // The stage is the paper the pages lie on: while one page dissolves into the
  // next, the paper stays and only what is on it changes.
  return (
    <div
      ref={surfaceRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onMouseOver={handleEntityLinkMouseOver}
      onMouseOut={handleEntityLinkMouseOut}
      style={{ position: 'relative', height: '100%', width: '100%', background: 'hsl(var(--page))' }}
    >
      {renderedSurfaces.map((surface) => (
        <WorkspaceSurface
          key={surface.revisionKey}
          descriptor={surface}
          projectId={projectId ?? ''}
          isVisible={surface.revisionKey === committedRevisionKey}
          isLeaving={surface.revisionKey === leavingRevisionKey}
          isDesired={surface.revisionKey === desiredRevisionKey}
          isInteractive={
            surface.revisionKey === committedRevisionKey &&
            surface.revisionKey === desiredRevisionKey
          }
          onReadyChange={handleSurfaceReadyChange}
          onSetSplitFocus={handleSetSplitFocus}
          onSetSplitRatio={handleSetSplitRatio}
        />
      ))}

      {committedRevisionKey === null && <EditorStageLoadingSurface />}

      {/* The pointer can cross into a link's card and scroll what does not fit. */}
      {entityHoverPreview && (
        <EntityHoverCard
          target={entityHoverPreview.data}
          anchor={entityHoverPreview.anchor}
          placement="bottom-start"
          pointer={entityHoverCard}
          onDismiss={entityHoverDismiss}
          maxHeight={PROSE_HOVER_CARD_MAX_HEIGHT}
        />
      )}

      {dropSide && <DropOverlay side={dropSide} />}
    </div>
  );
}

const WorkspaceSurface = memo(function WorkspaceSurface({
  descriptor,
  projectId,
  isVisible,
  isLeaving,
  isDesired,
  isInteractive,
  onReadyChange,
  onSetSplitFocus,
  onSetSplitRatio,
}: {
  descriptor: WorkspaceSurfaceDescriptor;
  projectId: string;
  isVisible: boolean;
  /** Replaced, still shown under the page in front until it is covered. */
  isLeaving: boolean;
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
        <TrailingEditorPaneContext.Provider value>
          <PaneRenderer leaf={tab} projectId={projectId} />
        </TrailingEditorPaneContext.Provider>
      </EditorSurfaceLifecycleProvider>
    );
  }

  // A leaving surface is only pixels: it is no longer the page in front for
  // its editors, assistive technology or the pointer.
  const isShown = isVisible || isLeaving;
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
        visibility: isShown ? 'visible' : 'hidden',
        contentVisibility: editorSurfaceContentVisibility(isShown, isDesired),
        pointerEvents: isInteractive ? 'auto' : 'none',
        zIndex: isVisible ? 2 : isLeaving ? 1 : 0,
      }}
    >
      {content}
      <TextInputLookupStop />
    </div>
  );
}, (previous, next) => previous.descriptor.revisionKey === next.descriptor.revisionKey
  && previous.descriptor.tab === next.descriptor.tab && previous.projectId === next.projectId
  && previous.isVisible === next.isVisible && previous.isLeaving === next.isLeaving
  && previous.isDesired === next.isDesired
  && previous.isInteractive === next.isInteractive && previous.onReadyChange === next.onReadyChange
  && previous.onSetSplitFocus === next.onSetSplitFocus && previous.onSetSplitRatio === next.onSetSplitRatio);

function EditorStageLoadingSurface() {
  const { t } = useTranslation();
  return (
    <div
      data-editor-stage-loading
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        display: 'grid',
        placeItems: 'center',
        background: 'hsl(var(--paper))',
        pointerEvents: 'none',
      }}
    >
      <LoadingStatus label={t('common.loading')} />
    </div>
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
  const { openEntity } = useProjectNavigation();
  const swapSplitPanes = useUiStore((s) => s.swapSplitPanes);
  const unsplitTab = useUiStore((s) => s.unsplitTab);
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
      <PaneDivider
        onMouseDown={onDividerMouseDown}
        onSwap={() => swapSplitPanes(projectId, split.id)}
        onUnsplit={() => {
          // Point the URL at what stays, so the URL → tab sync doesn't
          // re-add the pane that just left as a fresh preview tab.
          const { nextActive } = unsplitTab(projectId, split.id);
          if (nextActive) openEntity({ entityType: nextActive.entityType, id: nextActive.id });
        }}
      />
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
          <TrailingEditorPaneContext.Provider value>
            <PaneRenderer leaf={split.right} projectId={projectId} />
          </TrailingEditorPaneContext.Provider>
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

// Leaving the grip and its options gives the pointer this long to cross
// between them.
const SEAM_OPTIONS_GRACE_MS = 140;

/**
 * The seam between two split editors. Dragging anywhere on it resizes the
 * panes. Its middle carries a small I-shaped grip: resting on it (or focusing
 * it) unfolds the split's own operations on either side of it — swap the
 * panes on the left, undo the split on the right — while the grip stays put
 * as the drag handle; leaving them folds the options back.
 */
function PaneDivider({ onMouseDown, onSwap, onUnsplit }: {
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onSwap: () => void;
  onUnsplit: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const fold = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), SEAM_OPTIONS_GRACE_MS);
  };
  const choose = (action: () => void) => {
    window.clearTimeout(closeTimer.current);
    setOpen(false);
    action();
  };
  return (
    <div
      onMouseDown={(event) => {
        setOpen(false);
        onMouseDown(event);
      }}
      role="separator"
      aria-orientation="vertical"
      className="editor-split-seam"
    >
      <div
        className="editor-split-seam__grip-group"
        data-open={open}
        onMouseEnter={show}
        onMouseLeave={fold}
        onFocus={show}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) fold();
        }}
      >
        <button
          type="button"
          className="editor-split-seam__grip"
          aria-label={t('topTimeline.splitControls')}
          aria-expanded={open}
        />
        {([
          ['start', 'swap', t('topTimeline.menu.swapPanes'), onSwap],
          ['end', 'unsplit', t('topTimeline.menu.unsplit'), onUnsplit],
        ] as const).map(([side, key, label, action]) => (
          <div key={key} className={`editor-split-seam__options editor-split-seam__options--${side}`}>
            <button
              type="button"
              className="editor-split-seam__option glass glass--surface"
              tabIndex={open ? 0 : -1}
              // A press on an option is not the start of a seam drag.
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => choose(action)}
            >
              {label}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const PaneRenderer = memo(function PaneRenderer({ leaf, projectId }: { leaf: LeafTab; projectId: string }) {
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
    case 'library_item':
      return <MaterialEditorView key={leaf.id} libraryItemIdOverride={leaf.id} />;
    case 'all-chapters':
      return <AllChaptersEditorView />;
  }
});

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
