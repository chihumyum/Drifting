import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Ellipsis } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Touch cannot raise the DOM `contextmenu` event, so the editor's shared
 * selection menu (格式/批注/补丁/Copilot, built in useEntityEditor) is
 * unreachable on mobile — the system edit menu takes over instead. This chip
 * floats beside any editable-paper selection and synthesizes that exact
 * `contextmenu` event at the selection, so both shells run one menu path. */
export function MobileSelectionChip({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  const frameRef = useRef(0);

  useEffect(() => {
    if (!active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the anchor when the paper leaves is the intended reset
      setSpot(null);
      return undefined;
    }
    const update = () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        // While the shared menu is open the selection persists; the summoner
        // has done its job and stays away.
        if (document.querySelector('.editor-comment-menu')) {
          setSpot(null);
          return;
        }
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          setSpot(null);
          return;
        }
        const anchor = selection.anchorNode;
        const element = anchor instanceof Element ? anchor : anchor?.parentElement;
        if (!element?.closest('.m-paper-row__page[data-active="true"] .ProseMirror')) {
          setSpot(null);
          return;
        }
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          setSpot(null);
          return;
        }
        setSpot({
          x: Math.min(Math.max(rect.left + rect.width / 2, 30), window.innerWidth - 30),
          y: Math.max(rect.top - 34, 20),
        });
      });
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    update();
    return () => {
      cancelAnimationFrame(frameRef.current);
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [active]);

  if (!active || !spot) return null;

  const summon = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Consuming the pointer keeps the selection and the editor's focus
    // exactly as they are — the menu must open over an unchanged selection.
    event.preventDefault();
    event.stopPropagation();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const container = range.startContainer;
    const target =
      container instanceof Element ? container : container.parentElement;
    if (!target) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(
          Math.min(Math.max(rect.left + rect.width / 2, 12), window.innerWidth - 200),
        ),
        clientY: Math.round(Math.min(rect.top, Math.max(viewportHeight - 240, 80))),
      }),
    );
    setSpot(null);
  };

  return (
    <button
      type="button"
      className="m-selection-chip"
      data-debug-id="mobile-selection-chip"
      style={{ left: spot.x, top: spot.y }}
      aria-label={t('entityEditor.contextMenu.format', { defaultValue: '格式' })}
      onPointerDown={summon}
    >
      <Ellipsis size={16} aria-hidden="true" />
    </button>
  );
}
