import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { BrushIcon, type BrushIconName } from '../../components/ui/BrushIcon';
import { HoverCardHeading, HoverCardShell, type HoverActionGroup } from '../../components/ui/HoverCard';
import { useAuthorTyping } from '../../hooks/useAuthorTyping';
import { SYNC_MARK_TYPING_SETTLE_MS } from '../../lib/motion';
import { syncCornerFor, type SyncCornerState } from '../../sync/sync-health';
import { useSyncHealth } from '../../sync/sync-health-store';
import { useHoverPreview } from '../entities/hover/entity-hover-card-model';
import { useOptionalWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { syncActionsFor, useSyncStatusActions, type SyncStatusAction } from './sync-status-actions';
import { syncCornerText } from './sync-status-text';
import '../../../styles/paper-sync-mark.css';

type Glyph = 'cloud' | 'loose' | 'warning';

function glyphOf(state: SyncCornerState): Glyph | null {
  if (state.kind === 'none') return null;
  if (state.kind === 'problem') return 'warning';
  if (state.kind === 'offline') return 'loose';
  return 'cloud';
}

const ACTION: Record<SyncStatusAction, { label: string; icon: BrushIconName }> = {
  retry: { label: 'paperSync.retry', icon: 'rotate' },
  'sign-in': { label: 'paperSync.signIn', icon: 'gate-in' },
  'open-settings': { label: 'paperSync.openSettings', icon: 'dharma-wheel' },
};

/**
 * The open book's sync state, as one sand mark in the paper's lower-left
 * corner (docs/hosted-sync/sync-status.md). Synced, the corner is empty. A
 * long transfer shows a cloud that breathes; a retry blinks it; offline it is
 * loose sand; a problem the author has to act on is the danger seal, the same
 * one the bell wears. Pointing at it opens a hover card that says what is
 * happening and offers retry, sign-in or Settings.
 */
export function PaperSyncMark() {
  const { t, i18n } = useTranslation();
  const projectId = useOptionalWorkspaceNavigator()?.projectId ?? null;
  const health = useSyncHealth();
  const state = syncCornerFor(health, projectId);
  const glyph = glyphOf(state);
  const typing = useAuthorTyping(SYNC_MARK_TYPING_SETTLE_MS);
  const hover = useHoverPreview<null>();
  const run = useSyncStatusActions();

  const text = syncCornerText(state, t, i18n.language);
  const actions =
    state.kind === 'problem'
      ? syncActionsFor(state.problem)
      : state.kind === 'retrying' || state.kind === 'offline'
        ? syncActionsFor(state.kind)
        : [];
  const target =
    state.kind === 'problem'
      ? { problem: state.problem, syncGenerationIds: state.syncGenerationIds }
      : state.kind === 'retrying'
        ? { syncGenerationIds: state.syncGenerationIds }
        : {};
  const groups: HoverActionGroup[] = actions.length
    ? [{
        key: 'sync',
        actions: actions.map((action) => ({
          key: action,
          label: t(ACTION[action].label),
          icon: { brush: ACTION[action].icon },
          onSelect: () => run(action, target),
        })),
      }]
    : [];
  // A transfer steps aside while the author writes; anything that needs them stays.
  const fadedForTyping = typing && state.kind === 'syncing';
  // A card left open when the corner empties must not come back on its own.
  const { dismiss } = hover;
  useEffect(() => {
    if (!glyph) dismiss();
  }, [glyph, dismiss]);

  return (
    <div
      className="paper-sync-mark"
      data-state={state.kind}
      data-typing={fadedForTyping ? 'true' : undefined}
    >
      <span
        className="paper-sync-mark__mark"
        role="img"
        aria-label={text ? `${t('paperSync.label')}: ${text.title}` : undefined}
        aria-hidden={glyph ? undefined : true}
        tabIndex={glyph ? 0 : -1}
        onMouseEnter={(event) => {
          if (glyph) hover.onEnter(null, event.currentTarget);
        }}
        onMouseLeave={hover.onLeave}
        onFocus={(event) => {
          if (glyph) hover.open(null, event.currentTarget);
        }}
        onBlur={hover.onLeave}
      >
        <BrushIcon name="cloud" size={18} className={`paper-sync-mark__glyph${glyph === 'cloud' ? ' is-on' : ''}`} />
        <BrushIcon
          name="cloud"
          size={18}
          className={`paper-sync-mark__glyph paper-sync-mark__glyph--loose${glyph === 'loose' ? ' is-on' : ''}`}
        />
        <BrushIcon
          name="status-warning"
          size={18}
          className={`paper-sync-mark__glyph paper-sync-mark__glyph--warning${glyph === 'warning' ? ' is-on' : ''}`}
        />
      </span>
      {hover.preview && text && !fadedForTyping && (
        <HoverCardShell
          anchor={hover.preview.anchor}
          placement="top-center"
          label={t('paperSync.label')}
          pointer={hover.card}
          actions={groups}
          onDismiss={hover.dismiss}
        >
          <HoverCardHeading title={text.title} />
          {text.detail && <div className="hover-card__text">{text.detail}</div>}
          {text.reading && <div className="paper-sync-card__reading">{text.reading}</div>}
          {text.code && <div className="paper-sync-card__code">{text.code}</div>}
          {typeof text.ratio === 'number' && (
            <div className="sand-track paper-sync-card__track">
              <span className="sand-stroke" style={{ width: `${Math.max(2, Math.round(text.ratio * 100))}%` }} />
            </div>
          )}
        </HoverCardShell>
      )}
    </div>
  );
}
