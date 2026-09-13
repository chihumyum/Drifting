import { memo, useRef, type CSSProperties, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AnchoredPopover } from '../../components/ui/AnchoredPopover';
import type { BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';

export interface StoryGraphUnplacedChaptersProps {
  nodes: readonly BookNode[];
  primaryStorylineId(node: BookNode): string | null;
  storylineById: ReadonlyMap<string, Storyline>;
  open: boolean;
  onToggle(): void;
  onClose(): void;
  onNodePointerDown(event: PointerEvent<HTMLDivElement>, node: BookNode): void;
}

type ChapterListProps = Pick<StoryGraphUnplacedChaptersProps, 'nodes' | 'primaryStorylineId' | 'storylineById' | 'onNodePointerDown'>;

// AnchoredPopover only mounts its children while open, so a hidden list has no
// card work. The shell keeps the shared Escape stack and persistent drop commands.
function UnplacedChapters({ nodes, primaryStorylineId, storylineById, onNodePointerDown }: ChapterListProps) {
  const { t } = useTranslation();
  if (nodes.length === 0) return <div className="graph-head__unplaced-empty">{t('bottomTimeline.unplaced.empty')}</div>;
  return <>{nodes.map((node) => {
    const primaryId = primaryStorylineId(node);
    const sl = primaryId ? storylineById.get(primaryId) : null;
    const color = sl?.color || 'hsl(var(--ink-4))';
    return (
      <div
        key={node.id}
        className="graph-head__unplaced-chip"
        onPointerDown={(event) => onNodePointerDown(event, node)}
        style={{ ['--chip-color' as string]: color } as CSSProperties}
        title={node.title || t('common.untitled')}
      >
        <span className="graph-head__unplaced-chip-dot" />
        <span className="graph-head__unplaced-chip-num">
          § {String(node.bookOrder).padStart(2, '0')}
        </span>
        <span className="graph-head__unplaced-chip-title">
          {node.title || t('common.untitled')}
        </span>
      </div>
    );
  })}</>;
}

function UnplacedChapterPopover({ nodes, primaryStorylineId, storylineById, open, onToggle, onClose,
  onNodePointerDown,
}: StoryGraphUnplacedChaptersProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      className="graph-head__unplaced super-view-head__no-drag"
      data-tauri-drag-region="false"
    >
      <button
        ref={anchorRef}
        type="button"
        className={`graph-head__unplaced-btn${open ? ' is-open' : ''}`}
        onClick={onToggle}
        title={t('bottomTimeline.unplaced.title')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{t('bottomTimeline.unplaced.label')}</span>
        <span className="graph-head__unplaced-count">{nodes.length}</span>
      </button>
      <AnchoredPopover
        anchorRef={anchorRef}
        open={open}
        onClose={onClose}
        placement="bottom-start"
        className="menu-surface menu-surface--rich menu-surface--panel graph-head__unplaced-popover super-view-head__no-drag"
        role="dialog"
        ariaLabel={t('bottomTimeline.unplaced.title')}
        autoFocus={false}
        dismissOnEscape={false}
        maxHeight={260}
      >
        <UnplacedChapters nodes={nodes} primaryStorylineId={primaryStorylineId}
          storylineById={storylineById} onNodePointerDown={onNodePointerDown} />
      </AnchoredPopover>
    </div>
  );
}

export const StoryGraphUnplacedChapters = memo(UnplacedChapterPopover);
