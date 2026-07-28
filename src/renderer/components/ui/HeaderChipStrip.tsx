import {
  Children,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { countFittingHeaderChips } from './header-chip-overflow';

interface HeaderChipStripProps {
  children: ReactNode;
  className?: string;
}

/**
 * A single-line chip strip that keeps every item mounted for measurement but
 * only reveals the leading chips that fit completely. The trailing items stay
 * available to the adjacent "all types" menu instead of becoming a second
 * overflow control.
 */
export function HeaderChipStrip({ children, className = '' }: HeaderChipStripProps) {
  const items = Children.toArray(children);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const rightEdges = Array.from(content.children, (item) => {
      const element = item as HTMLElement;
      return element.offsetLeft + element.offsetWidth;
    });
    const nextVisibleCount = countFittingHeaderChips(rightEdges, viewport.clientWidth);
    setVisibleCount((current) => (current === nextVisibleCount ? current : nextVisibleCount));
  }, []);

  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return undefined;

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      observer.observe(content);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [items.length, measure]);

  if (items.length === 0) return null;

  return (
    <div
      ref={viewportRef}
      className={`header-chip-strip${className ? ` ${className}` : ''}`}
      data-tauri-drag-region="false"
    >
      <div ref={contentRef} className="header-chip-strip__content">
        {items.map((item, index) => {
          const hidden = index >= visibleCount;
          return (
            <span
              // Children.toArray normalizes stable child keys before this map.
              key={(item as { key?: string | number | null }).key ?? index}
              className="header-chip-strip__item"
              data-hidden={hidden ? '' : undefined}
              aria-hidden={hidden ? true : undefined}
            >
              {item}
            </span>
          );
        })}
      </div>
    </div>
  );
}
