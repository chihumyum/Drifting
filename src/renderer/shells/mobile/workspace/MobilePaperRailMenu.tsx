import { Check, ListTree, Menu, MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommentTargetKind } from '../../../domain/comment';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useEntityMarginNotes } from '../../../hooks/useEntityMarginNotes';
import { AnchoredPopover } from '../../../components/ui/AnchoredPopover';
import {
  mobilePaperRailAvailability,
  mobilePaperRailFromCommentVisibility,
  toggleMobilePaperRail,
  type MobilePaperRail,
} from './mobile-paper-rail';

function commentTarget(target: WorkspaceTarget | null): {
  kind: CommentTargetKind;
  id: string | null;
} {
  if (
    target?.entityType === 'node' ||
    target?.entityType === 'storyline' ||
    target?.entityType === 'element' ||
    target?.entityType === 'category'
  ) {
    return { kind: target.entityType, id: target.id };
  }
  return { kind: 'node', id: null };
}

export function MobilePaperRailMenu({
  target,
  activeRail,
  onActiveRailChange,
}: {
  target: WorkspaceTarget | null;
  activeRail: MobilePaperRail | null;
  onActiveRailChange: (rail: MobilePaperRail | null) => void;
}) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const availability = mobilePaperRailAvailability(target);
  const currentCommentTarget = commentTarget(target);
  const [commentsVisible, setCommentsVisible] = useEntityMarginNotes(
    currentCommentTarget.kind,
    currentCommentTarget.id,
  );
  const previousCommentsVisibleRef = useRef(commentsVisible);
  const previousActiveRailRef = useRef(activeRail);

  // Selection comments, the desktop-compatible editor toggle, and Copilot can
  // all change the shared rail from inside an editor. Mirror both directions
  // into the mobile shell so comments never mount behind TOC (or leave an
  // empty comments overlay behind after the editor closes them).
  useEffect(() => {
    const changed = previousCommentsVisibleRef.current !== commentsVisible;
    previousCommentsVisibleRef.current = commentsVisible;
    if (!changed) return;
    const next = mobilePaperRailFromCommentVisibility(
      activeRail,
      commentsVisible,
      availability.comments,
    );
    if (next !== activeRail) onActiveRailChange(next);
  }, [activeRail, availability.comments, commentsVisible, onActiveRailChange]);

  useEffect(() => {
    const previous = previousActiveRailRef.current;
    previousActiveRailRef.current = activeRail;
    if (previous !== 'comments' || activeRail === 'comments' || !commentsVisible) return;
    queueMicrotask(() => setCommentsVisible(false));
  }, [activeRail, commentsVisible, setCommentsVisible]);

  if ((!availability.toc && !availability.comments) || typeof document === 'undefined') {
    return null;
  }

  const selectRail = (requested: MobilePaperRail) => {
    const next = toggleMobilePaperRail(activeRail, requested);
    if (availability.comments) setCommentsVisible(next === 'comments');
    onActiveRailChange(next);
    setMenuOpen(false);
  };

  const trigger = (
    <button
      ref={buttonRef}
      type="button"
      className="m-unified-bar__action m-unified-bar__rail-trigger"
      data-debug-id="mobile-paper-actions"
      data-active={activeRail ?? 'none'}
      aria-label={t('mobileEditorRails.controls')}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={() => setMenuOpen((open) => !open)}
    >
      <Menu size={19} aria-hidden="true" />
      {activeRail !== null && <span aria-hidden="true" />}
    </button>
  );

  return (
    <>
      {trigger}
      <AnchoredPopover
        anchorRef={buttonRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        placement="bottom-end"
        offset={8}
        viewportPadding={12}
        className="menu-surface m-paper-rail-menu"
        role="menu"
        ariaLabel={t('mobileEditorRails.menu')}
        autoFocus={false}
        restoreFocus={false}
      >
        <div className="m-paper-rail-menu__label">{t('mobileEditorRails.menu')}</div>
        {availability.toc && (
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={activeRail === 'toc'}
            className={activeRail === 'toc' ? 'is-active' : undefined}
            onClick={() => selectRail('toc')}
          >
            <ListTree size={17} aria-hidden="true" />
            <span>{t('mobileEditorRails.toc')}</span>
            {activeRail === 'toc' && <Check size={15} aria-hidden="true" />}
          </button>
        )}
        {availability.comments && (
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={activeRail === 'comments'}
            className={activeRail === 'comments' ? 'is-active' : undefined}
            onClick={() => selectRail('comments')}
          >
            <MessageSquare size={17} aria-hidden="true" />
            <span>{t('mobileEditorRails.comments')}</span>
            {activeRail === 'comments' && <Check size={15} aria-hidden="true" />}
          </button>
        )}
      </AnchoredPopover>
    </>
  );
}
