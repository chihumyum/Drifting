import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useUiStore } from '../../store/ui-store';
import { useDataStore } from '../../store/data-store';
import { useAuthStore } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useStoryline } from '../../usecase/useStoryline';

// 三个带标签的 tab 平分整条 header 宽度所需的最小值。低于此值切到 glyph-only。
// 每个 tab 标签态约 56px，三个就是 168，加一点余量避免临界抖动。
const FULL_TABS_MIN_WIDTH = 180;

// Hover-out grace period for the chapter tab dropdown — gives the user a
// moment to slide from the tab onto the menu without it vanishing.
const DROPDOWN_HOVER_LEAVE_DELAY_MS = 120;

export function LeftSidebarHeader() {
  const activeLeftPanel = useUiStore((s) => s.activeLeftPanel);
  const setActiveLeftPanel = useUiStore((s) => s.setActiveLeftPanel);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setCompact(el.clientWidth < FULL_TABS_MIN_WIDTH);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        height: 40,
        width: '100%',
        borderBottom: '1px solid hsl(var(--rule))',
        alignItems: 'center',
        padding: '0 8px',
        // Allow the chapter-tab hover dropdown to escape this header
        // strip. Combined with the explicit z-index, this keeps the menu
        // visible above the panel content rendered below the header.
        overflow: 'visible',
        position: 'relative',
        zIndex: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          flex: 1,
          minWidth: 0,
          gap: 0,
          background: 'hsl(var(--paper-deep))',
          borderRadius: 4,
          padding: 2,
        }}
      >
        <ChapterPanelTab
          compact={compact}
          isActive={activeLeftPanel === 'nodes'}
          onClick={() => setActiveLeftPanel('nodes')}
        />
        <PanelTab
          label="元素"
          glyph="◆"
          compact={compact}
          isActive={activeLeftPanel === 'elements'}
          onClick={() => setActiveLeftPanel('elements')}
        />
        <PanelTab
          label="浮缀"
          glyph="✺"
          compact={compact}
          isActive={activeLeftPanel === 'drift'}
          onClick={() => setActiveLeftPanel('drift')}
        />
      </div>
    </div>
  );
}

/**
 * Chapter tab — same surface as PanelTab, plus a hover dropdown that exposes
 * view-mode switching:
 *   • 全书总览          → set `chapterPanelViewMode` to 'global'
 *   • 按 storyline 分类 → set `chapterPanelViewMode` to 'storyline'
 *
 * When the project has zero storylines the second option is replaced by
 * "新建 storyline" — clicking creates a fresh storyline (auto-migrating any
 * existing chapters into it via useStoryline.createStoryline's first-storyline
 * hook) and switches the view mode in the same gesture.
 *
 * The dropdown only opens while the tab is the active panel — switching to
 * another panel hides it. View-mode persistence is already handled by the
 * store; this menu is purely a controller.
 */
function ChapterPanelTab({
  compact,
  isActive,
  onClick,
}: {
  compact: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  const viewMode = useUiStore((s) => s.chapterPanelViewMode);
  const setViewMode = useUiStore((s) => s.setChapterPanelViewMode);
  const storylines = useDataStore((s) => s.storylines);
  const userId = useAuthStore((s) => s.user?.id);
  const { projectId, openEntity } = useProjectNavigation();
  const { createStoryline } = useStoryline({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });

  const hasStorylines = storylines.length > 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const handleEnter = useCallback(() => {
    clearLeaveTimer();
    setMenuOpen(true);
  }, [clearLeaveTimer]);

  const handleLeave = useCallback(() => {
    clearLeaveTimer();
    leaveTimerRef.current = setTimeout(() => {
      setMenuOpen(false);
    }, DROPDOWN_HOVER_LEAVE_DELAY_MS);
  }, [clearLeaveTimer]);

  const handlePickGlobal = useCallback(() => {
    setViewMode('global');
    setMenuOpen(false);
  }, [setViewMode]);

  const handlePickStoryline = useCallback(() => {
    setViewMode('storyline');
    setMenuOpen(false);
  }, [setViewMode]);

  const handleCreateFirstStoryline = useCallback(async () => {
    if (!projectId) return;
    setMenuOpen(false);
    try {
      const created = await createStoryline({ projectId, name: 'New Storyline' });
      // Switch to storyline-grouping mode so the user immediately sees the
      // new lane (and the just-migrated existing chapters within it).
      setViewMode('storyline');
      openEntity({ entityType: 'storyline', id: created.id }, { preview: false });
    } catch {
      /* swallow — surfaced via toast/log layer elsewhere when wired up */
    }
  }, [projectId, createStoryline, openEntity, setViewMode]);

  return (
    <div
      style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0 }}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <PanelTabButton
        label="章节"
        glyph="§"
        compact={compact}
        isActive={isActive}
        onClick={onClick}
      />

      {menuOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: 168,
            background: 'hsl(var(--surface))',
            border: '1px solid hsl(var(--rule))',
            borderRadius: 4,
            boxShadow: '0 6px 18px hsl(var(--ink-1) / 0.10)',
            padding: 4,
            zIndex: 50,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.06em',
          }}
        >
          <MenuRow
            label="全书总览"
            checked={viewMode === 'global' || !hasStorylines}
            onClick={handlePickGlobal}
          />
          {hasStorylines ? (
            <MenuRow
              label="按 storyline 分类"
              checked={viewMode === 'storyline'}
              onClick={handlePickStoryline}
            />
          ) : (
            <MenuRow
              label="新建 storyline"
              hint="把现有章节归入一条新建的故事线"
              onClick={() => void handleCreateFirstStoryline()}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  label,
  hint,
  checked,
  onClick,
}: {
  label: string;
  hint?: string;
  checked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        all: 'unset',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        width: '100%',
        padding: '6px 8px',
        borderRadius: 3,
        cursor: 'pointer',
        color: 'hsl(var(--ink-1))',
        transition: 'background 0.1s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'hsl(var(--paper-deep))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden
          style={{
            width: 10,
            color: 'hsl(var(--accent))',
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 12,
          }}
        >
          {checked ? '✓' : ''}
        </span>
        <span>{label}</span>
      </span>
      {hint && (
        <span
          style={{
            paddingLeft: 16,
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 10.5,
            letterSpacing: 0,
            color: 'hsl(var(--ink-3))',
          }}
        >
          {hint}
        </span>
      )}
    </button>
  );
}

function PanelTab({
  label,
  glyph,
  compact,
  isActive,
  onClick,
}: {
  label: string;
  glyph?: string;
  compact: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0 }}>
      <PanelTabButton
        label={label}
        glyph={glyph}
        compact={compact}
        isActive={isActive}
        onClick={onClick}
      />
    </div>
  );
}

function PanelTabButton({
  label,
  glyph,
  compact,
  isActive,
  onClick,
}: {
  label: string;
  glyph?: string;
  compact: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={compact ? label : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 0 : 6,
        flex: 1,
        minWidth: 0,
        background: isActive ? 'hsl(var(--surface))' : 'transparent',
        color: isActive ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-3))',
        padding: compact ? '4px 8px' : '4px 10px',
        fontSize: 11.5,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em',
        fontWeight: 500,
        border: 'none',
        borderRadius: 3,
        boxShadow: isActive ? '0 1px 2px hsl(var(--ink-1) / 0.06)' : 'none',
        transition: 'background 0.15s, color 0.15s',
        textAlign: 'center',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.color = 'hsl(var(--ink-1))';
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.color = 'hsl(var(--ink-3))';
      }}
    >
      {glyph && (
        <span
          aria-hidden
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 12.5,
            color: isActive ? 'hsl(var(--accent))' : 'hsl(var(--ink-4))',
            lineHeight: 1,
          }}
        >
          {glyph}
        </span>
      )}
      {!compact && <span>{label}</span>}
    </button>
  );
}
