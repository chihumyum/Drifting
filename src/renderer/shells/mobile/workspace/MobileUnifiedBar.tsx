import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Layers3,
  Search,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { getActiveEditor } from '../../../lib/active-editor';
import type { MobilePaper } from './mobile-workspace-session';
import { useMobilePaperPresentation } from './MobilePaperContent';
import { MobileEditorAccessory } from './MobileEditorAccessory';
import { MobilePanelPullHandle } from './MobilePanelPullHandle';
import { MobilePaperRailMenu } from './MobilePaperRailMenu';
import { requestMobileWorkspaceBack } from './mobile-workspace-back';
import {
  selectMobileUnifiedBarProjection,
  type MobileWorkspaceUiState,
} from './mobile-workspace-controller';
import type { MobilePaperRail } from './mobile-paper-rail';
import type { MobilePanelGestureCommit } from './mobile-panel-gesture';
import {
  MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT,
  readMobileKeyboardInset,
  readMobileSoftwareKeyboardVisible,
} from './mobile-keyboard-geometry';
import {
  emptyMobilePaperSearchSnapshot,
  getMobilePaperSearchOwner,
  subscribeMobilePaperSearchOwner,
  type MobilePaperSearchOwner,
} from './mobile-paper-search';
import {
  getMobileAllChaptersContext,
  subscribeMobileAllChaptersContext,
} from './mobile-all-chapters-context';

const subscribeNothing = () => () => undefined;

function MobileUnifiedSearch({
  owner,
  onProjectSearch,
}: {
  owner: MobilePaperSearchOwner | null;
  onProjectSearch: (query: string) => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seededOwnerRef = useRef<MobilePaperSearchOwner | null>(null);
  const snapshot = useSyncExternalStore(
    owner?.subscribe ?? subscribeNothing,
    owner?.getSnapshot ?? emptyMobilePaperSearchSnapshot,
    emptyMobilePaperSearchSnapshot,
  );
  useLayoutEffect(() => {
    // Search owns this input, not the prose editor. Native `autoFocus` lets
    // WebKit scroll the paper to expose a bottom-edge control before the IME
    // geometry arrives. Focus explicitly without scrolling so opening Search
    // never masquerades as an editor/caret transition.
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    // Seed a selected prose range once per Search session. An empty query after
    // Backspace is author input, not permission to reinsert the selection.
    if (!owner || seededOwnerRef.current === owner) return;
    seededOwnerRef.current = owner;
    if (snapshot.query) return;
    const editor = getActiveEditor();
    if (!editor || editor.isDestroyed) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const selected = editor.state.doc.textBetween(from, to, ' ').trim();
    if (selected) owner.setQuery(selected);
  }, [owner, snapshot.query]);
  return (
    <div className="m-unified-search">
      <button
        type="button"
        className="m-unified-search__scope"
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onProjectSearch(snapshot.query)}
        aria-label={t('mobileWorkspace.search.projectScope', {
          defaultValue: '在整个项目中搜索',
        })}
      >
        {t('mobileWorkspace.search.paperScope', { defaultValue: '本纸' })}
      </button>
      <input
        ref={inputRef}
        value={snapshot.query}
        onChange={(event) => owner?.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (event.shiftKey) owner?.previous();
          else owner?.next();
        }}
        placeholder={t('findPanel.currentPlaceholder')}
        aria-label={t('findPanel.currentPlaceholder')}
      />
      <span aria-live="polite">
        {snapshot.status === 'searching'
          ? '…'
          : snapshot.total === 0
            ? '0/0'
            : `${snapshot.currentIndex + 1}/${snapshot.total}`}
      </span>
    </div>
  );
}

function MobileUnifiedSearchStep({
  disabled,
  onActivate,
  label,
  children,
}: {
  disabled: boolean;
  onActivate: () => void;
  label: string;
  children: ReactNode;
}) {
  const activateFromPointer = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!disabled) onActivate();
  };
  const keepSearchFocusedFromMouse = (event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const activateFromAccessibility = (event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!disabled && event.detail === 0) onActivate();
  };

  return (
    <span
      role="button"
      className="m-unified-bar__action m-unified-search__step"
      aria-disabled={disabled ? 'true' : 'false'}
      aria-label={label}
      onPointerDown={activateFromPointer}
      onMouseDown={keepSearchFocusedFromMouse}
      onClick={activateFromAccessibility}
    >
      {children}
    </span>
  );
}

function MobileUnifiedBarPaperIdentity({
  paper,
  onOpenStats,
}: {
  paper: MobilePaper;
  onOpenStats: () => void;
}) {
  const presentation = useMobilePaperPresentation(paper.target);
  const allChaptersContext = useSyncExternalStore(
    subscribeMobileAllChaptersContext,
    getMobileAllChaptersContext,
    getMobileAllChaptersContext,
  );
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="m-unified-bar__paper"
      data-debug-id="mobile-open-paper-stats"
      onClick={onOpenStats}
      aria-label={t('mobileWorkspace.paperStats.open', { defaultValue: '查看当前纸张统计' })}
    >
      <span style={{ background: presentation.color || 'hsl(var(--ink-4))' }} />
      <span>
        <small>
          {paper.target.entityType === 'all-chapters' && allChaptersContext.actName
            ? `${presentation.kicker} · ${allChaptersContext.actName}`
            : presentation.kicker}
        </small>
        <strong>
          {paper.target.entityType === 'all-chapters' && allChaptersContext.chapterTitle
            ? allChaptersContext.chapterTitle
            : presentation.title}
        </strong>
      </span>
    </button>
  );
}

function MobileUnifiedBackAction({
  preserveFocusUntilBack,
  onBack,
  label,
}: {
  preserveFocusUntilBack: boolean;
  onBack: () => void;
  label: string;
}) {
  if (!preserveFocusUntilBack) {
    return (
      <button
        type="button"
        className="m-unified-bar__action"
        data-debug-id="mobile-unified-back"
        onClick={onBack}
        aria-label={label}
      >
        <ArrowLeft size={20} aria-hidden="true" />
      </button>
    );
  }

  const keepEditorFocused = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onBack();
  };
  const handleClick = (event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.detail === 0) onBack();
  };

  return (
    <span
      role="button"
      className="m-unified-bar__action"
      data-debug-id="mobile-unified-back"
      onPointerDown={keepEditorFocused}
      onPointerUp={handlePointerUp}
      onClick={handleClick}
      aria-label={label}
    >
      <ArrowLeft size={20} aria-hidden="true" />
    </span>
  );
}

export function MobileUnifiedBar({
  workspaceUi,
  activePaper,
  paperCount,
  activeRail,
  keyboardInset,
  panelExtent,
  onPanelDragStateChange,
  onPanelExtentChange,
  onPanelExtentCommit,
  onOpenOverview,
  onOpenStats,
  onOpenSearch,
  onProjectSearch,
  onActiveRailChange,
  editorAccessoryMode,
  onEditorAccessoryModeChange,
  onEditingStateChange,
  onKeyboardStateChange,
  onKeyboardInsetChange,
  onKeyboardViewportOffsetTopChange,
}: {
  workspaceUi: MobileWorkspaceUiState;
  activePaper: MobilePaper | null;
  paperCount: number;
  activeRail: MobilePaperRail | null;
  keyboardInset: number;
  panelExtent: number;
  onPanelDragStateChange: (panel: 'top' | 'bottom', dragging: boolean) => void;
  onPanelExtentChange: (panel: 'top' | 'bottom', extent: number) => void;
  onPanelExtentCommit: (panel: 'top' | 'bottom', gesture: MobilePanelGestureCommit) => void;
  onOpenOverview: () => void;
  onOpenStats: () => void;
  onOpenSearch: () => void;
  onProjectSearch: (query: string) => void;
  onActiveRailChange: (rail: MobilePaperRail | null) => void;
  editorAccessoryMode: 'navigation' | 'formatting';
  onEditorAccessoryModeChange: (mode: 'navigation' | 'formatting') => void;
  onEditingStateChange: (editing: boolean) => void;
  onKeyboardStateChange: (keyboard: 'closed' | 'open') => void;
  onKeyboardInsetChange: (inset: number) => void;
  onKeyboardViewportOffsetTopChange: (offsetTop: number) => void;
}) {
  const { t } = useTranslation();
  const projection = selectMobileUnifiedBarProjection(workspaceUi);
  const searchOwner = useSyncExternalStore(
    subscribeMobilePaperSearchOwner,
    getMobilePaperSearchOwner,
    () => null,
  );

  useEffect(() => {
    if (projection.mode !== 'search') return undefined;
    const viewport = window.visualViewport;
    let frame = 0;
    const sync = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const inset = readMobileKeyboardInset();
        onKeyboardInsetChange(inset);
        onKeyboardStateChange(readMobileSoftwareKeyboardVisible() ? 'open' : 'closed');
      });
    };
    sync();
    viewport?.addEventListener('resize', sync);
    viewport?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    window.addEventListener(MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, sync);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', sync);
      viewport?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      window.removeEventListener(MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, sync);
      searchOwner?.clear();
    };
  }, [
    onKeyboardInsetChange,
    onKeyboardStateChange,
    projection.mode,
    searchOwner,
  ]);
  const showPaperNavigation =
    projection.mode === 'read' ||
    (projection.mode === 'edit' && editorAccessoryMode === 'navigation');
  // Every editor-owned Back must keep ProseMirror focused until the typed Back
  // request resolves. Otherwise pointerdown emits blur first, the controller
  // becomes read, and the later click is incorrectly resolved as paper-root.
  const backPreservesFocusUntilResolution =
    projection.mode === 'edit' || projection.mode === 'search';
  const handleBack = () =>
    requestMobileWorkspaceBack('visible', {
      preflightDom: projection.mode !== 'edit' && projection.mode !== 'search',
    });
  const backLabel = t('navigation.back');
  const preserveSearchFocus = (
    event: ReactPointerEvent<HTMLDivElement> | ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (projection.mode !== 'search') return;
    if (event.target instanceof Element && event.target.closest('input')) return;
    // WKWebView may still synthesize a compatibility mousedown after a touch
    // pointer. Cancelling both defaults at the bar boundary makes the search
    // field the sole DOM focus owner for every non-Back search action.
    event.preventDefault();
  };

  return (
    <footer
      className="m-unified-bar"
      data-debug-id="mobile-unified-bar"
      data-mode={projection.mode}
      data-placement={projection.placement}
      data-keyboard={workspaceUi.keyboard}
      data-visible={projection.visible ? 'true' : 'false'}
      style={{ '--m-unified-keyboard-inset': `${keyboardInset}px` } as CSSProperties}
      aria-label={t('mobileWorkspace.unifiedBar', { defaultValue: '移动工作栏' })}
    >
      <MobilePanelPullHandle
        panel="bottom"
        extent={workspaceUi.panel.startsWith('bottom-') ? panelExtent : 0}
        disabled={projection.mode === 'search'}
        onDragStateChange={onPanelDragStateChange}
        onExtentChange={onPanelExtentChange}
        onExtentCommit={onPanelExtentCommit}
      />
      <div
        className="m-unified-bar__content"
        onPointerDownCapture={preserveSearchFocus}
        onMouseDownCapture={preserveSearchFocus}
      >
        {projection.mode === 'search' ? (
          <>
            <MobileUnifiedBackAction
              preserveFocusUntilBack={backPreservesFocusUntilResolution}
              onBack={handleBack}
              label={backLabel}
            />
            <MobileUnifiedSearch owner={searchOwner} onProjectSearch={onProjectSearch} />
            <MobileUnifiedSearchStep
              disabled={!searchOwner}
              onActivate={() => searchOwner?.previous()}
              label={t('findPanel.previousTitle')}
            >
              <ChevronUp size={19} aria-hidden="true" />
            </MobileUnifiedSearchStep>
            <MobileUnifiedSearchStep
              disabled={!searchOwner}
              onActivate={() => searchOwner?.next()}
              label={t('findPanel.nextTitle')}
            >
              <ChevronDown size={19} aria-hidden="true" />
            </MobileUnifiedSearchStep>
          </>
        ) : (
          <>
            <MobileUnifiedBackAction
              preserveFocusUntilBack={backPreservesFocusUntilResolution}
              onBack={handleBack}
              label={backLabel}
            />
            <MobileEditorAccessory
              active={projection.mode === 'edit'}
              mode={editorAccessoryMode}
              onModeChange={onEditorAccessoryModeChange}
              onEditingStateChange={onEditingStateChange}
              onKeyboardInsetChange={onKeyboardInsetChange}
              onKeyboardViewportOffsetTopChange={onKeyboardViewportOffsetTopChange}
            />
            {showPaperNavigation && activePaper ? (
            <div className="m-unified-bar__read-center">
              <MobileUnifiedBarPaperIdentity
                paper={activePaper}
                onOpenStats={onOpenStats}
              />
              <button
                type="button"
                className="m-unified-bar__action m-unified-bar__count"
                data-debug-id="mobile-open-overview"
                onClick={onOpenOverview}
                aria-label={t('mobileWorkspace.openPapers', { defaultValue: '打开的纸张' })}
              >
                <span>{paperCount}</span>
              </button>
              <button
                type="button"
                className="m-unified-bar__action"
                data-debug-id="mobile-open-search"
                onPointerDown={(event) => {
                  if (projection.mode === 'edit') event.preventDefault();
                }}
                onClick={onOpenSearch}
                aria-label={t('mobileWorkspace.search.open', { defaultValue: '搜索' })}
              >
                <Search size={19} aria-hidden="true" />
              </button>
              <MobilePaperRailMenu
                target={activePaper.target}
                activeRail={activeRail}
                onActiveRailChange={onActiveRailChange}
                onOpenOverview={onOpenOverview}
              />
            </div>
            ) : showPaperNavigation ? (
              <span className="m-unified-bar__empty">
                <Layers3 size={18} aria-hidden="true" /> Drifting
              </span>
            ) : null}
          </>
        )}
      </div>
    </footer>
  );
}
