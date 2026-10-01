import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';

export function CommentBodyEditor({
  text,
  busy = false,
  onSave,
  onClose,
}: {
  text: string;
  busy?: boolean;
  onSave: (body: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const savingRef = useRef(false);

  const save = async () => {
    const body = draft.trim();
    if (!body || busy || savingRef.current) return;
    if (body === text) {
      onClose();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFailed(false);
    try {
      await onSave(body);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      className="review-card__editor"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
          event.stopPropagation();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!savingRef.current) onClose();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          void save();
        }
      }}
    >
      <textarea
        autoFocus
        aria-label={t('common.edit')}
        value={draft}
        rows={4}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
      />
      {failed && <div role="alert">{t('common.saveFailed')}</div>}
      <div className="review-card__editor-actions">
        <Button size="sm" variant="ghost" disabled={saving} onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" disabled={!draft.trim() || busy || saving} onClick={() => void save()}>
          {t(saving ? 'common.saving' : 'common.save')}
        </Button>
      </div>
    </div>
  );
}
