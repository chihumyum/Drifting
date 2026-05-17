import { useCallback } from 'react';

export interface OutlineEntry {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  num?: string;
}

interface Props {
  title: string;
  items: OutlineEntry[];
  activeId?: string | null;
  onItemClick?: (id: string) => void;
  footLeft?: string;
  footRight?: string;
  emptyHint?: string;
}

// Sticky left-rail outline shared by all entity editors. Render inside an
// `.editor__spread`. Items can be h1/h2/h3; an h2 with a `num` shows the
// Chinese ordinal accent before the title (一/二/三).
export function EditorOutlinePanel({
  title,
  items,
  activeId,
  onItemClick,
  footLeft,
  footRight,
  emptyHint = '— 暂无标题 —',
}: Props) {
  const handleClick = useCallback(
    (id: string) => () => onItemClick?.(id),
    [onItemClick],
  );

  return (
    <nav className="editor__toc" aria-label="Outline">
      <div className="toc-head">
        <span>{title}</span>
        {items.length > 0 && <span className="toc-head__count">{items.length} 节</span>}
      </div>

      {items.length === 0 ? (
        <div className="toc-empty">{emptyHint}</div>
      ) : (
        items.map((item) => {
          const cls = `toc-item toc-item--h${item.level}${activeId === item.id ? ' toc-item--active' : ''}`;
          return (
            <a key={item.id} className={cls} onClick={handleClick(item.id)}>
              {item.num && <span className="toc-item__num">{item.num}</span>}
              <span>{item.text}</span>
            </a>
          );
        })
      )}

      {(footLeft || footRight) && (
        <div className="toc-foot">
          <span>{footLeft ?? ''}</span>
          <span>{footRight ?? ''}</span>
        </div>
      )}
    </nav>
  );
}
