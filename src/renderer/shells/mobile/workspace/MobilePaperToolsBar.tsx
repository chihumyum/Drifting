import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AnchoredPopover } from '../../../components/ui/AnchoredPopover';
import type { MobilePaperRail } from './mobile-paper-rail';

/** The paper tab is now a small display-options popover. */
export function MobilePaperToolsBar({ hidden = false, anchorRef, openRails, onToggleRail, onClose }: {
  hidden?: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  openRails: Record<MobilePaperRail, boolean>;
  onToggleRail: (rail: MobilePaperRail) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toggles: Array<[MobilePaperRail, string]> = [
    ['toc', t('mobileWorkspace.paperAgent.outline')],
    ['comments', t('reviewPanel.stickyRail')],
  ];
  return <AnchoredPopover anchorRef={anchorRef} open={!hidden} onClose={onClose} placement="top-end" className="m-paper-switches" ariaLabel={t('mobileWorkspace.paperTools')}>
    {toggles.map(([rail, label]) => <button key={rail} type="button" role="switch" aria-checked={openRails[rail]} onClick={() => onToggleRail(rail)}><span>{label}</span><i aria-hidden="true" /></button>)}
  </AnchoredPopover>;
}
