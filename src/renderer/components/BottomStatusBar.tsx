import { Home } from 'lucide-react';
import { useUiStore, usePromoteCurrentTab } from '../store/ui-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import {
  IcebergIcon,
  AllChaptersIcon,
  AllRefsIcon,
  StoryGraphViewIcon,
} from './BottomStatusBarIcons';
import '../../styles/bottom-status-bar.css';

// BottomStatusBar — always-visible compact footer. Hosts the project-global
// nav segments (Home / All-Chapters) and super-view toggles (Element / Story
// Graph / Memo & Material) on the left, the BottomTimeline visibility toggle
// on the right.

type SuperViewId = 'element' | 'graph' | 'memo-material';

export function BottomStatusBar() {
  const bottomTimelineHidden = useUiStore((s) => s.bottomTimelineHidden);
  const toggleBottomTimelineHidden = useUiStore((s) => s.toggleBottomTimelineHidden);

  const { projectId, navigateToHome, navigateToAllChapters } = useProjectNavigation();
  // Mirror ChapterPanel's "double-click promotes the preview tab to a dedicated
  // tab" gesture — so Home / 通览全书 can open as a real tab without a
  // right-click detour.
  const promoteCurrentTab = usePromoteCurrentTab(projectId);

  const activeSuperView = useUiStore((s) => s.activeSuperView);
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const toggleSuper = (id: SuperViewId) =>
    setActiveSuperView(activeSuperView === id ? 'none' : id);

  const shadowMode = useUiStore((s) => s.shadowMode);
  const toggleShadowMode = useUiStore((s) => s.toggleShadowMode);

  // Nav-icon clicks should ALWAYS land the user on the navigated route —
  // when a super view is overlaying the editor, clicking Home / 通览全书
  // would otherwise silently open the tab in the background while the
  // overlay still covers it. Dismiss the super view as part of the nav
  // gesture so the user sees the new route immediately.
  const dismissSuperView = () => {
    if (activeSuperView !== 'none') setActiveSuperView('none');
  };

  return (
    <div className="bsb app-chrome app-island">
      <button
        type="button"
        className="bsb__seg bsb__nav"
        onClick={() => {
          dismissSuperView();
          navigateToHome();
        }}
        onDoubleClick={() => promoteCurrentTab()}
        title="Project Home"
        aria-label="Project Home"
      >
        <Home size={11} strokeWidth={1.6} />
      </button>
      <button
        type="button"
        className="bsb__seg bsb__nav"
        onClick={() => {
          dismissSuperView();
          navigateToAllChapters();
        }}
        onDoubleClick={() => promoteCurrentTab()}
        title="通览全书"
        aria-label="通览全书"
      >
        <AllChaptersIcon size={14} />
      </button>

      <button
        type="button"
        className={`bsb__seg bsb__super${activeSuperView === 'element' ? ' is-active' : ''}`}
        onClick={() => toggleSuper('element')}
        title="Elements"
        aria-label="Elements"
      >
        <IcebergIcon size={14} />
      </button>
      <button
        type="button"
        className={`bsb__seg bsb__super${activeSuperView === 'graph' ? ' is-active' : ''}`}
        onClick={() => toggleSuper('graph')}
        title="Story Graph"
        aria-label="Story Graph"
      >
        <StoryGraphViewIcon size={14} />
      </button>
      <button
        type="button"
        className={`bsb__seg bsb__super${activeSuperView === 'memo-material' ? ' is-active' : ''}`}
        onClick={() => toggleSuper('memo-material')}
        title="TODO & Library"
        aria-label="TODO & Library"
      >
        <AllRefsIcon size={14} />
      </button>

      <div className="bsb__spacer" />
      <button
        type="button"
        className={`bsb__seg bsb__shadow${shadowMode ? ' is-active' : ''}`}
        onClick={toggleShadowMode}
        title={shadowMode ? '退回 Shadow' : '唤起 Shadow'}
        aria-label={shadowMode ? '退回 Shadow' : '唤起 Shadow'}
      >
        <span
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          ◐
        </span>
        <span>Shadow</span>
      </button>
      <button
        type="button"
        className={`bsb__seg bsb__timeline-toggle${bottomTimelineHidden ? '' : ' is-open'}`}
        onClick={toggleBottomTimelineHidden}
        title={bottomTimelineHidden ? '展开 Storyline Timeline' : '收起 Storyline Timeline'}
        aria-label={bottomTimelineHidden ? '展开 Storyline Timeline' : '收起 Storyline Timeline'}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
          <line x1="1.5" y1="7" x2="14.5" y2="7" />
          <line x1="4" y1="10.5" x2="9" y2="10.5" />
        </svg>
        <span>Timeline</span>
      </button>
    </div>
  );
}
