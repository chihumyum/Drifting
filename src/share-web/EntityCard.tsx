import { createPortal } from 'react-dom';
import { KindMark } from '../renderer/components/ui/KindMark';
import type { KindMarkKind } from '../renderer/components/ui/kind-mark';
import type { ShareEntity } from '../shared/share-document';
import { ENTITY_FALLBACK_COLOR, type OpenEntityCard } from './entity-card-state';

const CARD_ROOM = 220;

const MARK: Record<ShareEntity['kind'], KindMarkKind> = {
  element: 'element',
  node: 'chapter',
  category: 'category',
  storyline: 'storyline',
};

/** The entity's name and summary, below its link, or above it near the bottom of the window. */
export function EntityCard({ open, entity }: { open: OpenEntityCard; entity: ShareEntity }) {
  const width = Math.min(320, window.innerWidth - 24);
  const left = Math.min(Math.max(12, open.rect.left), window.innerWidth - width - 12);
  const below = open.rect.bottom + 8 + CARD_ROOM <= window.innerHeight;
  const color = entity.color ?? ENTITY_FALLBACK_COLOR[entity.kind];
  return createPortal(
    <div
      id="entity-card"
      role="tooltip"
      className="entity-card"
      style={below ? { left, top: open.rect.bottom + 8 } : { left, bottom: window.innerHeight - open.rect.top + 8 }}
    >
      <p className="entity-card__name">
        <KindMark kind={MARK[entity.kind]} color={color} seed={entity.name} />
        {entity.name}
      </p>
      {entity.summary && <p className="entity-card__summary">{entity.summary}</p>}
    </div>,
    document.body,
  );
}
