import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import type { ImageQuotaSnapshot } from '../../platform';

export interface ElementImageGenerateRequest {
  styleText: string;
  extraPrompt: string;
  count: number;
}

const COUNT_OPTIONS = ['1', '2', '3', '4'] as const;

interface ElementImageGenerateFormProps {
  /** Current project art style fact; edits are saved back when generating. */
  styleText: string;
  quota: ImageQuotaSnapshot | null;
  /** Why generation cannot start (e.g. no ChatGPT sign-in); null when ready. */
  blockedReason: string | null;
  onSubmit: (request: ElementImageGenerateRequest) => void;
  onCancel: () => void;
}

/**
 * The request in front of the background Agent generation task. Mounted per
 * opening, so the style re-seeds from the project fact and the extra prompt
 * starts empty each time.
 */
export function ElementImageGenerateForm({
  styleText,
  quota,
  blockedReason,
  onSubmit,
  onCancel,
}: ElementImageGenerateFormProps) {
  const { t } = useTranslation();
  const [style, setStyle] = useState(styleText);
  const [extraPrompt, setExtraPrompt] = useState('');
  const [count, setCount] = useState<(typeof COUNT_OPTIONS)[number]>('2');

  const quotaLine =
    quota?.usedPercent != null
      ? t('elementEditor.imageGeneration.quota', {
          percent: quota.usedPercent,
          reset: quota.resetsAtMs
            ? new Date(quota.resetsAtMs).toLocaleString(undefined, {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })
            : '—',
        })
      : null;

  return (
    <form
      className="elem-imagegen__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (blockedReason) return;
        onSubmit({ styleText: style.trim(), extraPrompt: extraPrompt.trim(), count: Number(count) });
      }}
    >
      <div className="elem-imagegen__title">{t('elementEditor.imageGeneration.title')}</div>
      <label className="elem-imagegen__field">
        <span className="elem-imagegen__label">{t('elementEditor.imageGeneration.style')}</span>
        <textarea
          className="elem-imagegen__input"
          value={style}
          onChange={(event) => setStyle(event.target.value)}
          placeholder={t('elementEditor.imageGeneration.stylePlaceholder')}
          rows={2}
        />
        <span className="elem-imagegen__hint">{t('elementEditor.imageGeneration.styleHint')}</span>
      </label>
      <label className="elem-imagegen__field">
        <span className="elem-imagegen__label">{t('elementEditor.imageGeneration.extra')}</span>
        <textarea
          className="elem-imagegen__input"
          value={extraPrompt}
          onChange={(event) => setExtraPrompt(event.target.value)}
          placeholder={t('elementEditor.imageGeneration.extraPlaceholder')}
          rows={3}
        />
      </label>
      <div className="elem-imagegen__row">
        <span className="elem-imagegen__label">{t('elementEditor.imageGeneration.count')}</span>
        <SegmentedControl
          size="sm"
          value={count}
          options={COUNT_OPTIONS.map((value) => ({ value, label: value }))}
          onChange={setCount}
          ariaLabel={t('elementEditor.imageGeneration.count')}
        />
      </div>
      {quotaLine && <div className="elem-imagegen__hint">{quotaLine}</div>}
      {blockedReason && (
        <div className="elem-imagegen__blocked" role="alert">
          {blockedReason}
        </div>
      )}
      <div className="elem-imagegen__actions">
        <button type="button" className="elem-imagegen__button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          className="elem-imagegen__button elem-imagegen__button--primary"
          disabled={Boolean(blockedReason)}
        >
          {t('elementEditor.imageGeneration.submit')}
        </button>
      </div>
    </form>
  );
}
