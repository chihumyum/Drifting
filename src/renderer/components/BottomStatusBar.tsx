import { useCallback, useEffect, useRef, useState } from 'react';
import { Home } from 'lucide-react';
import { useUiStore, usePromoteCurrentTab } from '../store/ui-store';
import { useSettingsStore } from '../store/settings-store';
import { setTypewriterMode } from '../lib/typewriter-mode';
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
  // Mirror NodesPanel's "double-click promotes the preview tab to a dedicated
  // tab" gesture — so Home / 通览全书 can open as a real tab without a
  // right-click detour.
  const promoteCurrentTab = usePromoteCurrentTab(projectId);

  const activeSuperView = useUiStore((s) => s.activeSuperView);
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const toggleSuper = (id: SuperViewId) =>
    setActiveSuperView(activeSuperView === id ? 'none' : id);

  const shadowMode = useUiStore((s) => s.shadowMode);
  const toggleShadowMode = useUiStore((s) => s.toggleShadowMode);

  const typewriterMode = useSettingsStore((s) => s.typewriterMode);
  const setTypewriter = useSettingsStore((s) => s.setTypewriterMode);
  // Keep the real DOM-side hook in sync with the persisted setting. Runs
  // once on mount so a writer who left it on yesterday gets it back today.
  useEffect(() => {
    setTypewriterMode(typewriterMode);
  }, [typewriterMode]);

  // Nav-icon clicks should ALWAYS land the user on the navigated route —
  // when a super view is overlaying the editor, clicking Home / 通览全书
  // would otherwise silently open the tab in the background while the
  // overlay still covers it. Dismiss the super view as part of the nav
  // gesture so the user sees the new route immediately.
  const dismissSuperView = () => {
    if (activeSuperView !== 'none') setActiveSuperView('none');
  };

  return (
    <div className="bsb">
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
        title="Memo & Material"
        aria-label="Memo & Material"
      >
        <AllRefsIcon size={14} />
      </button>

      <div className="bsb__spacer" />

      <button
        type="button"
        className={`bsb__seg bsb__tool${typewriterMode ? ' is-active' : ''}`}
        onClick={() => setTypewriter(!typewriterMode)}
        title={typewriterMode ? '关闭打字机模式' : '开启打字机模式（光标常居中）'}
        aria-label="Typewriter mode"
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1 }}>≡</span>
        <span>Typewriter</span>
      </button>

      <WritingTimer />

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

// ─── Writing Timer ───────────────────────────────────────────────
// Click cycles start → pause → resume. Right-click resets to 00:00.
// State lives in-component because BottomStatusBar is always mounted at
// the Layout level — navigating between tabs / projects doesn't unmount
// it, so a single ref persists for the life of the session. A page
// reload wipes it (intentional — sessions shouldn't span reloads).
function WritingTimer() {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [running, setRunning] = useState(false);
  // Start instant of the *current* run segment. When paused, we bank the
  // segment into `elapsedMs` and clear this; on resume we set it to now.
  const startedAtRef = useRef<number | null>(null);
  // Render driver — bumped once per second while running so the display
  // refreshes. We avoid storing `displayMs` in state because the source
  // of truth is wall-clock; reading it on render is exact.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!running) return undefined;
    startedAtRef.current = Date.now();
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const liveDelta =
    running && startedAtRef.current != null ? Date.now() - startedAtRef.current : 0;
  const totalMs = elapsedMs + liveDelta;

  const toggle = useCallback(() => {
    setRunning((cur) => {
      if (cur && startedAtRef.current != null) {
        // Pausing — bank the current segment.
        const bank = Date.now() - startedAtRef.current;
        setElapsedMs((prev) => prev + bank);
        startedAtRef.current = null;
        return false;
      }
      return true;
    });
  }, []);

  const reset = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setRunning(false);
    startedAtRef.current = null;
    setElapsedMs(0);
  }, []);

  const sec = Math.floor(totalMs / 1000);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const display =
    hh > 0
      ? `${String(hh)}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;

  return (
    <button
      type="button"
      className={`bsb__seg bsb__tool bsb__timer${running ? ' is-active' : ''}`}
      onClick={toggle}
      onContextMenu={reset}
      title={
        running
          ? '点击暂停 · 右键归零'
          : totalMs > 0
            ? '点击继续 · 右键归零'
            : '点击开始计时 · 右键归零'
      }
      aria-label="Writing timer"
    >
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1 }}>
        {running ? '◉' : '○'}
      </span>
      <span style={{ fontFeatureSettings: '"tnum"' }}>{display}</span>
    </button>
  );
}
