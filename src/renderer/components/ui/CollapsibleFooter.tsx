import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp } from 'lucide-react';
import { useSettingsStore } from '../../store/settings-store';

/**
 * Shared collapsible footer drawer used by the sidebar panels:
 * ChapterPanel「未归属」, DriftPanel「休眠」, TodoPanel「已完成」,
 * ShadowPanel「已归档」. One implementation so the four stay in lockstep — a
 * 28px header strip pinned to the bottom of the panel, a chevron-left
 * disclosure toggle (a real <button>, so it's keyboard- and screen-reader
 * reachable), and a top-edge drag handle that resizes the expanded height,
 * clamped between `minHeight` and 90% of the parent panel.
 *
 * Both the expand state and the height can be controlled or left internal:
 * ChapterPanel feeds a persisted height in from the ui-store; ShadowPanel
 * controls the expand state so it can fold the drawer shut after a bulk
 * delete. Everyone else just lets the component own both.
 */

export const COLLAPSIBLE_FOOTER_HEADER_HEIGHT = 28;
const DEFAULT_EXPANDED_HEIGHT = 200;
const DEFAULT_MIN_HEIGHT = 80;
const RESIZE_HANDLE_HEIGHT = 6;
// Never let the footer eat more than this fraction of the panel.
const MAX_HEIGHT_RATIO = 0.9;

export interface CollapsibleFooterProps {
  /** Left-cluster label, rendered right after the chevron. */
  label: ReactNode;
  /** Optional count shown after the label in dimmer ink. */
  count?: number;
  /** Extra left-cluster content (e.g. an agent-activity badge). */
  headerExtra?: ReactNode;
  /** Right-aligned header content, only shown while expanded (e.g. a clear button). */
  headerActions?: ReactNode;

  /** Controlled expanded state. Omit to let the component own it. */
  expanded?: boolean;
  /** Initial expanded state when uncontrolled. */
  defaultExpanded?: boolean;
  onExpandedChange?: (next: boolean) => void;

  /** Controlled expanded height in px (null → defaultHeight). Omit for internal state. */
  height?: number | null;
  onHeightChange?: (next: number) => void;
  /** Expanded height when uncontrolled / when a controlled height is null. */
  defaultHeight?: number;
  minHeight?: number;

  /** Toggle tooltips. */
  expandTitle?: string;
  collapseTitle?: string;

  /** Expanded body. */
  children: ReactNode;
  /** Style applied to the scrolling body container (typically padding/gap). */
  bodyStyle?: CSSProperties;
}

export function CollapsibleFooter({
  label,
  count,
  headerExtra,
  headerActions,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  height,
  onHeightChange,
  defaultHeight = DEFAULT_EXPANDED_HEIGHT,
  minHeight = DEFAULT_MIN_HEIGHT,
  expandTitle,
  collapseTitle,
  children,
  bodyStyle,
}: CollapsibleFooterProps) {
  const { t } = useTranslation();
  const expandedControlled = expanded !== undefined;
  const [expandedInternal, setExpandedInternal] = useState(defaultExpanded);
  const isExpanded = expandedControlled ? Boolean(expanded) : expandedInternal;
  const setExpanded = useCallback(
    (next: boolean) => {
      if (!expandedControlled) setExpandedInternal(next);
      onExpandedChange?.(next);
    },
    [expandedControlled, onExpandedChange],
  );

  const heightControlled = height !== undefined;
  const [heightInternal, setHeightInternal] = useState(defaultHeight);
  const currentHeight = heightControlled ? height ?? defaultHeight : heightInternal;
  const setHeight = useCallback(
    (next: number) => {
      if (!heightControlled) setHeightInternal(next);
      onHeightChange?.(next);
    },
    [heightControlled, onHeightChange],
  );

  // Expand/collapse easing is a modern-skin flourish only — classic snaps
  // open/closed instantly (matches the sidebar slide, which classic also skips).
  const animate = useSettingsStore((s) => s.appearanceSkin === 'modern');

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const teardownRef = useRef<(() => void) | null>(null);

  const startDrag = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      const startHeight = currentHeight;
      // Measure the panel at drag-start so the clamp doesn't chase a layout
      // that's mid-resize. The footer is a direct child of the panel column.
      const panelHeight = rootRef.current?.parentElement?.getBoundingClientRect().height ?? 0;
      const max =
        panelHeight > 0
          ? Math.max(minHeight, Math.round(panelHeight * MAX_HEIGHT_RATIO))
          : Number.POSITIVE_INFINITY;
      setIsDragging(true);

      const onMove = (ev: MouseEvent) => {
        // Pointer up → drawer shrinks; up → grows.
        const next = startHeight + (startY - ev.clientY);
        setHeight(Math.max(minHeight, Math.min(max, next)));
      };
      const teardown = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', teardown);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setIsDragging(false);
        teardownRef.current = null;
      };
      teardownRef.current = teardown;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', teardown);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    },
    [currentHeight, minHeight, setHeight],
  );

  // Belt-and-braces: if we unmount mid-drag, tear the listeners down so we
  // neither leak handlers nor strand the body cursor.
  useEffect(() => () => teardownRef.current?.(), []);

  return (
    <div
      ref={rootRef}
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
        borderTop: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--paper-deep) / 0.5)',
        minHeight: COLLAPSIBLE_FOOTER_HEADER_HEIGHT,
        height: isExpanded ? currentHeight : COLLAPSIBLE_FOOTER_HEADER_HEIGHT,
        // Smooth the open/close toggle (modern only); drop the transition
        // mid-drag so the resize cursor stays glued to the edge.
        transition: isDragging || !animate ? 'none' : 'height 0.18s ease',
      }}
    >
      {/* Top-edge resize grip — only while expanded so the collapsed strip
          can't accidentally start a drag. Overlays the border, above the
          header so click-to-toggle never competes with mousedown. */}
      {isExpanded && (
        <div
          onMouseDown={startDrag}
          title={t('common.resizeHeight')}
          aria-hidden
          style={{
            position: 'absolute',
            top: -RESIZE_HANDLE_HEIGHT / 2,
            left: 0,
            right: 0,
            height: RESIZE_HANDLE_HEIGHT,
            cursor: 'ns-resize',
            zIndex: 5,
          }}
        />
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: COLLAPSIBLE_FOOTER_HEADER_HEIGHT,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          title={isExpanded ? collapseTitle : expandTitle}
          style={{
            all: 'unset',
            boxSizing: 'border-box',
            flex: 1,
            minWidth: 0,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 12px',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'hsl(var(--ink-3))',
          }}
        >
          <ChevronUp
            size={12}
            style={{
              flexShrink: 0,
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: animate ? 'transform 0.18s ease' : 'none',
            }}
          />
          <span
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {label}
          </span>
          {count !== undefined && <span style={{ color: 'hsl(var(--ink-4))' }}>{count}</span>}
          {headerExtra}
        </button>
        {isExpanded && headerActions ? (
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>{headerActions}</div>
        ) : null}
      </div>

      {isExpanded && (
        <div
          className="scroll-no-bar"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', ...bodyStyle }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
