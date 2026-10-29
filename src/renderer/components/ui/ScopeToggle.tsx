import { useTranslation } from 'react-i18next';

/**
 * A two-state switch between "just the current one" and the whole project,
 * shaped like the dock's lock: one word that never changes ("当前") in every
 * panel and for every kind of thing, resting glass while off, the still
 * selected glass while on. Pressed means the panel shows only what belongs to
 * the current tab's chapter, element, material or idea.
 */
export function ScopeToggle({
  pressed,
  disabled = false,
  onToggle,
  className = '',
}: {
  pressed: boolean;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`scope-toggle glass glass--rest${className ? ` ${className}` : ''}`}
      aria-pressed={pressed}
      disabled={disabled}
      title={t(pressed ? 'scopeToggle.hintOn' : 'scopeToggle.hintOff')}
      onClick={onToggle}
    >
      {t('scopeToggle.label')}
    </button>
  );
}
