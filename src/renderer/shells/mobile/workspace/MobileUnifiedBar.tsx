import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  Layers3,
  PanelBottom,
  PanelTop,
  Search,
} from 'lucide-react';
import { useEffect, useSyncExternalStore, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { getActiveEditor } from '../../../lib/active-editor';
import type { MobilePaper } from './mobile-workspace-session';
import { useMobilePaperPresentation } from './MobilePaperContent';
import { MobileEditorAccessory } from './MobileEditorAccessory';
import { MobilePaperRailMenu } from './MobilePaperRailMenu';
import { requestMobileWorkspaceBack } from './mobile-workspace-back';
import {
  selectMobileUnifiedBarProjection,
  type MobileWorkspacePanel,
  type MobileWorkspaceUiState,
} from './mobile-workspace-controller';
import type { MobilePaperRail } from './mobile-paper-rail';
import { nextMobilePanelForBar } from './mobile-unified-bar-state';
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
  const snapshot = useSyncExternalStore(
    owner?.subscribe ?? subscribeNothing,
    owner?.getSnapshot ?? emptyMobilePaperSearchSnapshot,
    emptyMobilePaperSearchSnapshot,
  );
  useEffect(() => {
    if (!owner || snapshot.query) return;
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
        onClick={() => onProjectSearch(snapshot.query)}
        aria-label={t('mobileWorkspace.search.projectScope', {
          defaultValue: '在整个项目中搜索',
        })}
      >
        {t('mobileWorkspace.search.paperScope', { defaultValue: '本纸' })}
      </button>
      <input
        autoFocus
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

function MobileUnifiedBarPaperIdentity({
  paper,
  paperCount,
  onOpenOverview,
}: {
  paper: MobilePaper;
  paperCount: number;
  onOpenOverview: () => void;
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
      data-debug-id="mobile-open-overview"
      onClick={onOpenOverview}
      aria-label={t('mobileWorkspace.openPapers', { defaultValue: '打开的纸张' })}
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
      <em>{paperCount}</em>
    </button>
  );
}

export function MobileUnifiedBar({
  workspaceUi,
  activePaper,
  paperCount,
  activeRail,
  keyboardInset,
  onWorkspacePanelChange,
  onOpenOverview,
  onOpenSearch,
  onProjectSearch,
  onActiveRailChange,
  editorAccessoryExpanded,
  onEditorAccessoryExpandedChange,
  onEditingStateChange,
  onKeyboardStateChange,
  onKeyboardInsetChange,
}: {
  workspaceUi: MobileWorkspaceUiState;
  activePaper: MobilePaper | null;
  paperCount: number;
  activeRail: MobilePaperRail | null;
  keyboardInset: number;
  onWorkspacePanelChange: (panel: MobileWorkspacePanel) => void;
  onOpenOverview: () => void;
  onOpenSearch: () => void;
  onProjectSearch: (query: string) => void;
  onActiveRailChange: (rail: MobilePaperRail | null) => void;
  editorAccessoryExpanded: boolean;
  onEditorAccessoryExpandedChange: (expanded: boolean) => void;
  onEditingStateChange: (editing: boolean) => void;
  onKeyboardStateChange: (keyboard: 'closed' | 'open') => void;
  onKeyboardInsetChange: (inset: number) => void;
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
      onKeyboardInsetChange(0);
      onKeyboardStateChange('closed');
    };
  }, [onKeyboardInsetChange, onKeyboardStateChange, projection.mode, searchOwner]);
  const handleBack = () => {
    if (projection.leftAction === 'dismiss-keyboard') getActiveEditor()?.commands.blur();
    requestMobileWorkspaceBack('visible');
  };
  const setPanel = (side: 'top' | 'bottom') =>
    onWorkspacePanelChange(nextMobilePanelForBar(workspaceUi.panel, side));

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
      <div className="m-unified-bar__left">
        <button
          type="button"
          className="m-unified-bar__action"
          data-debug-id="mobile-unified-back"
          disabled={projection.leftAction === 'disabled'}
          onClick={handleBack}
          aria-label={
            projection.leftAction === 'dismiss-keyboard'
              ? t('mobileWorkspace.dismissKeyboard', { defaultValue: '收起键盘' })
              : t('navigation.back')
          }
        >
          {projection.leftAction === 'dismiss-keyboard' ? (
            <ChevronsDown size={20} aria-hidden="true" />
          ) : (
            <ArrowLeft size={20} aria-hidden="true" />
          )}
        </button>
      </div>

      <div className="m-unified-bar__center">
        {projection.mode === 'search' ? (
          <MobileUnifiedSearch owner={searchOwner} onProjectSearch={onProjectSearch} />
        ) : (
          <MobileEditorAccessory
          expanded={editorAccessoryExpanded}
          onExpandedChange={onEditorAccessoryExpandedChange}
          onEditingStateChange={onEditingStateChange}
          onKeyboardStateChange={onKeyboardStateChange}
          onKeyboardInsetChange={onKeyboardInsetChange}
          />
        )}
        {projection.mode !== 'edit' && activePaper ? (
          projection.mode === 'search' ? null : (
            <div className="m-unified-bar__read-center">
              <MobileUnifiedBarPaperIdentity
                paper={activePaper}
                paperCount={paperCount}
                onOpenOverview={onOpenOverview}
              />
              <button
                type="button"
                className="m-unified-bar__action"
                data-debug-id="mobile-open-search"
                onClick={onOpenSearch}
                aria-label={t('mobileWorkspace.search.open', { defaultValue: '搜索' })}
              >
                <Search size={19} aria-hidden="true" />
              </button>
              <MobilePaperRailMenu
                target={activePaper.target}
                activeRail={activeRail}
                onActiveRailChange={onActiveRailChange}
              />
            </div>
          )
        ) : projection.mode !== 'edit' ? (
          <span className="m-unified-bar__empty">
            <Layers3 size={18} aria-hidden="true" /> Drifting
          </span>
        ) : null}
      </div>

      <div className="m-unified-bar__right">
        {projection.mode === 'search' ? (
          <>
            <button
              type="button"
              className="m-unified-bar__action"
              disabled={!searchOwner}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => searchOwner?.previous()}
              aria-label={t('findPanel.previousTitle')}
            >
              <ChevronUp size={19} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="m-unified-bar__action"
              disabled={!searchOwner}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => searchOwner?.next()}
              aria-label={t('findPanel.nextTitle')}
            >
              <ChevronDown size={19} aria-hidden="true" />
            </button>
          </>
        ) : projection.mode === 'edit' ? (
          <MobilePaperRailMenu
            target={activePaper?.target ?? null}
            activeRail={activeRail}
            onActiveRailChange={onActiveRailChange}
          />
        ) : (
          <>
            <button
              type="button"
              className="m-unified-bar__action"
              data-debug-id="mobile-structure-panel"
              aria-pressed={workspaceUi.panel.startsWith('top-')}
              onClick={() => setPanel('top')}
              aria-label={t('leftSidebar.title')}
            >
              <PanelTop size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="m-unified-bar__action"
              data-debug-id="mobile-tools-panel"
              aria-pressed={workspaceUi.panel.startsWith('bottom-')}
              onClick={() => setPanel('bottom')}
              aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}
            >
              <PanelBottom size={20} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </footer>
  );
}
