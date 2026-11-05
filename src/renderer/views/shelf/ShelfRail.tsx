import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NotificationPill } from '../../components/notifications/NotificationPill';
import { UserMenu } from '../../components/topBars/UserMenu';
import { AccountAvatar } from '../../components/ui/AccountAvatar';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { hostedAccountSettingsEnabled } from '../../features/settings/hosted-settings-policy';
import { syncCornerText } from '../../features/sync-status/sync-status-text';
import { useAuthStore } from '../../store/auth';
import { syncLibraryCornerFor } from '../../sync/sync-health';
import { useSyncHealth } from '../../sync/sync-health-store';
import { formatShelfWords } from './shelf-format';

/**
 * The shelf's left column, the workspace's left column kept on the shelf:
 * the shelf's name and how much the library holds at the top; at the foot
 * the import of a `.driftingbook`, Recently Deleted, and the account cell
 * with the library's sync state (none while writing locally), which opens
 * the account menu upward, beside the notification bell, whose center opens
 * upward too.
 */
export function ShelfRail({ books, words, trashCount, importing, onImport, onOpenTrash }: {
  books: number;
  /** Every book's words, or null while some are still being counted. */
  words: number | null;
  trashCount: number;
  importing: boolean;
  onImport: () => void;
  onOpenTrash: () => void;
}) {
  const { t, i18n } = useTranslation();
  const user = useAuthStore((s) => s.hostedUser);
  const hostedStatus = useAuthStore((s) => s.hostedStatus);
  const health = useSyncHealth();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const signedIn = hostedAccountSettingsEnabled() && Boolean(user?.email) && hostedStatus !== 'signed-out';
  const displayName = user?.name?.trim() || user?.email?.split('@')[0] || t('common.local');
  const corner = syncLibraryCornerFor(health);
  const cornerText = syncCornerText(corner, t, i18n.language);
  // Writing locally the name already says it: there is no sync to report.
  const status = !signedIn
    ? null
    : corner.kind === 'problem'
      ? { text: cornerText?.title ?? '', icon: 'status-warning' as const, tone: ' pp-rail__status--danger' }
      : corner.kind === 'offline'
        ? { text: cornerText?.title ?? '', icon: null, tone: '' }
        : corner.kind === 'syncing' || corner.kind === 'retrying'
          ? { text: cornerText?.title ?? '', icon: 'cloud' as const, tone: ' pp-rail__status--moving' }
          : { text: t('projectPicker.rail.synced'), icon: 'cloud' as const, tone: '' };

  return (
    <aside className="pp-rail">
      <h1 className="pp-head__title">{t('projectPicker.header.titleEm')}</h1>
      <div className="pp-rail__library">
        {words === null
          ? t('projectPicker.rail.books', { count: books })
          : t('projectPicker.rail.library', { count: books, words: formatShelfWords(words, i18n.language) })}
      </div>
      <div className="pp-rail__grow" />
      <button
        type="button"
        className="pp-rail__cell glass"
        title={t('userMenu.importBook')}
        disabled={importing}
        aria-busy={importing || undefined}
        onClick={onImport}
      >
        <BrushIcon name={importing ? 'loader' : 'arrow-in'} size={16} className={importing ? 'ui-spin' : undefined} />
        <span className="pp-rail__text">
          <span className="pp-rail__label">{t('projectPicker.rail.import')}</span>
          <span className="pp-rail__meta">.driftingbook</span>
        </span>
      </button>
      <button type="button" className="pp-rail__cell glass" onClick={onOpenTrash}>
        <BrushIcon name="trash" size={16} />
        <span className="pp-rail__text">
          <span className="pp-rail__label">{t('projectPicker.desk.trashEntry')}</span>
          {trashCount > 0 && <span className="pp-rail__meta">{trashCount}</span>}
        </span>
      </button>
      <div className="pp-rail__foot">
        <button
          ref={triggerRef}
          type="button"
          className="pp-rail__account glass"
          title={displayName}
          aria-label={t(hostedAccountSettingsEnabled() ? 'userMenu.accountMenu' : 'userMenu.localMenu')}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="pp-rail__avatar" aria-hidden="true">
            <AccountAvatar image={user?.image} initial={displayName.charAt(0).toUpperCase()} />
          </span>
          <span className="pp-rail__who">
            <span className="pp-rail__name">{displayName}</span>
            {status && (
              <span className={`pp-rail__status${status.tone}`}>
                {status.icon && <BrushIcon name={status.icon} size={12} />}
                <span>{status.text}</span>
              </span>
            )}
          </span>
        </button>
        <NotificationPill opens="up" />
      </div>
      <UserMenu
        triggerRef={triggerRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        scope="shelf"
        placement="top-start"
      />
    </aside>
  );
}
