import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface CommentSnapshotModalProps {
  snapshots: { blockId: string | null; blockText: string }[];
  liveBlockIds: Set<string>;
  onClose(): void;
}

export function CommentSnapshotModal({
  snapshots,
  liveBlockIds,
  onClose,
}: CommentSnapshotModalProps) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="snapshot-modal__overlay" onClick={onClose} role="presentation">
      <div
        className="snapshot-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={t('commentRail.snapshot.aria')}
      >
        <div className="snapshot-modal__head">
          <span>{t('commentRail.snapshot.title', { count: snapshots.length })}</span>
          <button
            type="button"
            className="mnote__icon-btn"
            onClick={onClose}
            aria-label={t('commentRail.actions.close')}
          >
            <X size={12} />
          </button>
        </div>
        <div className="snapshot-modal__body">
          {snapshots.map((snapshot, index) => {
            const gone = snapshot.blockId != null && !liveBlockIds.has(snapshot.blockId);
            return (
              <p
                key={snapshot.blockId ?? `snapshot-${index}`}
                className={`snapshot-modal__block${gone ? ' snapshot-modal__block--gone' : ''}`}
              >
                {gone && (
                  <span className="snapshot-modal__flag">{t('commentRail.snapshot.changed')}</span>
                )}
                {snapshot.blockText || (
                  <span className="snapshot-modal__empty">
                    {t('commentRail.snapshot.emptyBlock')}
                  </span>
                )}
              </p>
            );
          })}
        </div>
      </div>
    </div>
  );
}
