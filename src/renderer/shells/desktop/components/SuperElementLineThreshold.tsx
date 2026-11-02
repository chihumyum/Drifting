import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnchoredPopover } from '../../../components/ui/AnchoredPopover';
import { Button } from '../../../components/ui/Button';
import { GlassSlider } from '../../../components/ui/GlassSlider';
import { parseIsleLineThreshold } from '../../../features/graph/element-isles-model';

/** Presets and an author-chosen paragraph threshold share the same automatic lines. */
export function SuperElementLineThreshold({ value, onChange }: {
  value: number;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const groupRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const parsed = parseIsleLineThreshold(draft);
  const custom = value > 3;

  return (
    <div ref={groupRef} className="se-line-threshold">
      <span className="se-line-threshold__label" title={t('superElement.isles.thresholdHint')}>
        {t('superElement.isles.thresholdLabel')}
      </span>
      <GlassSlider
        ariaLabel={t('superElement.isles.threshold')}
        value={custom ? 'custom' : String(value)}
        onChange={(next) => {
          if (next !== 'custom') {
            setOpen(false);
            onChange(Number(next));
            return;
          }
          anchorRef.current = groupRef.current?.querySelector<HTMLButtonElement>('[data-value="custom"]') ?? null;
          setDraft(String(value));
          setOpen(true);
        }}
        options={[
          ...['1', '2', '3'].map((preset) => ({ value: preset, label: t('superElement.isles.atLeast', { count: Number(preset) }) })),
          { value: 'custom', label: custom ? t('superElement.isles.atLeast', { count: value }) : t('superElement.isles.customThreshold'), title: t('superElement.isles.customThreshold') },
        ]}
      />
      <AnchoredPopover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        ariaLabel={t('superElement.isles.customThreshold')}
        className="menu-surface se-line-threshold__popover"
        style={{ zIndex: 'var(--z-popover)' }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed === null) return;
            onChange(parsed);
            setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <label className="se-line-threshold__label" htmlFor={inputId}>{t('superElement.isles.threshold')}</label>
          <div className="ui-field glass glass--rest glass--field">
            <input
              id={inputId}
              autoFocus
              type="text"
              inputMode="numeric"
              value={draft}
              aria-describedby={hintId}
              aria-invalid={parsed === null || undefined}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
          <p id={hintId} className="se-line-threshold__hint">{t('superElement.isles.customThresholdHint')}</p>
          <div className="se-line-threshold__actions">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" size="sm" disabled={parsed === null}>{t('common.confirm')}</Button>
          </div>
        </form>
      </AnchoredPopover>
    </div>
  );
}
