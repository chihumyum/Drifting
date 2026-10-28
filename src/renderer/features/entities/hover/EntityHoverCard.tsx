import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { buildEntityHoverCardContent, type EntityHoverTarget } from './entity-hover-card-model';
import type { EntityHoverCardPlacement } from '../../../components/ui/entity-hover-card-position';
import {
  HoverCardShell,
  type HoverActionGroup,
  type HoverCardPointerProps,
} from '../../../components/ui/HoverCard';

export function EntityHoverCard({
  target,
  anchor,
  placement = 'right-start',
  pointer,
  actions,
  onDismiss,
}: {
  target: EntityHoverTarget;
  anchor: HTMLElement;
  placement?: EntityHoverCardPlacement;
  /** From the owner's hover state, so the pointer can reach the actions. */
  pointer?: HoverCardPointerProps;
  /** What the thing's right-click menu used to offer, along the card's bottom. */
  actions?: HoverActionGroup[];
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  const state = useDataStoreFields(
    'bookNodes',
    'bookElements',
    'bookElementCategories',
    'storylines',
    'nodeStorylineMapping',
    'primaryStorylineByNode',
    'storylineNodeMapping',
    'driftGroups',
  );
  const content = useMemo(() => buildEntityHoverCardContent(target, state, t), [state, t, target]);

  const hasActions = Boolean(actions?.some((group) => group.actions.length > 0));
  if (!content && !hasActions) return null;
  return (
    <HoverCardShell anchor={anchor} placement={placement} label={content?.title ?? undefined}
      pointer={pointer} actions={actions} onDismiss={onDismiss}>
      {content && <EntityHoverCardBody content={content} />}
    </HoverCardShell>
  );
}

function EntityHoverCardBody({ content }: { content: NonNullable<ReturnType<typeof buildEntityHoverCardContent>> }) {
  const { t } = useTranslation();
  const summary = content.summary?.trim() ?? '';
  return (
    <>
      {content.title && (
        <div
          style={{
            marginBottom: 8,
            color: 'hsl(var(--ink-1))',
            fontSize: 12.5,
            fontWeight: 600,
            lineHeight: 1.3,
            overflowWrap: 'anywhere',
          }}
        >
          {content.title}
        </div>
      )}
      {content.meta.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 5,
            marginBottom: 9,
          }}
        >
          {content.meta.map((item, index) => (
            <span
              key={`${item.text}:${index}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 0,
                maxWidth: '100%',
                padding: '2px 6px',
                borderRadius: 1,
                border:
                  item.tone === 'secondary'
                    ? '1px solid hsl(var(--rule) / 0.55)'
                    : '1px solid hsl(var(--rule))',
                background:
                  item.tone === 'secondary' ? 'hsl(var(--paper) / 0.55)' : 'hsl(var(--paper))',
                color: item.tone === 'secondary' ? 'hsl(var(--ink-4))' : 'hsl(var(--ink-3))',
                fontSize: 10.5,
                lineHeight: 1.35,
                overflowWrap: 'anywhere',
              }}
            >
              {item.color && (
                <span
                  aria-hidden
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: item.color,
                    opacity: item.tone === 'secondary' ? 0.62 : 1,
                  }}
                />
              )}
              {item.text}
            </span>
          ))}
        </div>
      )}
      <div
        style={{
          color: summary ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
          fontSize: 11.5,
          fontStyle: summary ? 'normal' : 'italic',
          lineHeight: 1.55,
          overflowWrap: 'anywhere',
          whiteSpace: 'pre-wrap',
        }}
      >
        {summary || t('nodeHoverPreview.noSummary')}
      </div>
    </>
  );
}
