import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { isStructuralEntityKind } from '../../../domain/entity-kinds';
import { EntityHoverCard } from '../../../features/entities/hover/EntityHoverCard';
import type { EntityHoverTarget } from '../../../features/entities/hover/entity-hover-card-model';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';

/** A prose card is never taller than this on a phone; longer bodies scroll in it. */
const NAME_CARD_MAX_HEIGHT = 360;

function linkTarget(link: Element): EntityHoverTarget | null {
  const kind = link.getAttribute('data-target-kind') ?? 'element';
  const id = link.getAttribute('data-target-id');
  if (!id || !isStructuralEntityKind(kind)) return null;
  return { kind, id };
}

/**
 * Reading on a phone, a name in the prose is a door (docs/mobile-ui-foundation.md):
 * a tap on a linked name brings up that element's own card under it, the one
 * a resting pointer brings up on the desktop, with a row that opens it. The
 * tap does not put the caret there, so reading never raises the keyboard by
 * accident; while the author writes, a tap on a name places the caret as
 * anywhere else.
 */
export function MobileProseNameCard({ paperRef, writing, onOpen }: {
  paperRef: RefObject<HTMLElement | null>;
  writing: boolean;
  onOpen: (target: WorkspaceTarget) => void;
}) {
  const { t } = useTranslation();
  const [card, setCard] = useState<{ target: EntityHoverTarget; anchor: HTMLElement } | null>(null);

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper || writing) return undefined;
    const nameAt = (event: Event): HTMLElement | null => {
      if (document.documentElement.getAttribute('data-entity-link-interactive') === 'off') return null;
      const origin = event.target instanceof Element ? event.target : null;
      const link = origin?.closest<HTMLElement>('.ProseMirror .entity-link') ?? null;
      return link && paper.contains(link) ? link : null;
    };
    let touchedAt = 0;
    const open = (event: Event) => {
      const link = nameAt(event);
      if (!link) return;
      const target = linkTarget(link);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      setCard({ target, anchor: link });
    };
    // A finger's tap ends on touchend: cancelling it there keeps WebKit from
    // focusing the prose and sending the click.
    const onTouchEnd = (event: TouchEvent) => {
      if (event.changedTouches.length !== 1) return;
      touchedAt = performance.now();
      open(event);
    };
    const onClick = (event: MouseEvent) => {
      if (performance.now() - touchedAt < 600) return;
      open(event);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (nameAt(event)) event.preventDefault();
    };
    paper.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    paper.addEventListener('mousedown', onMouseDown, true);
    paper.addEventListener('click', onClick, true);
    return () => {
      paper.removeEventListener('touchend', onTouchEnd, true);
      paper.removeEventListener('mousedown', onMouseDown, true);
      paper.removeEventListener('click', onClick, true);
    };
  }, [paperRef, writing]);

  useEffect(() => {
    if (writing) setCard(null);
  }, [writing]);

  if (!card) return null;
  const { target } = card;
  const kind = target.kind;
  const opens = kind === 'node' || kind === 'element' || kind === 'category' || kind === 'storyline' ? kind : null;
  return (
    <EntityHoverCard
      target={target}
      anchor={card.anchor}
      placement="bottom-start"
      maxHeight={NAME_CARD_MAX_HEIGHT}
      onDismiss={() => setCard(null)}
      actions={opens ? [{
        key: 'open',
        actions: [{
          key: 'open',
          label: t('mobileDesk.paper.openName'),
          icon: { brush: 'arrow-out' },
          onSelect: () => {
            setCard(null);
            onOpen({ entityType: opens, id: target.id });
          },
        }],
      }] : undefined}
    />
  );
}
