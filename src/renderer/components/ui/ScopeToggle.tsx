import { useTranslation } from 'react-i18next';
import type { ScopeToggleSubject } from './scope-toggle';

/**
 * A two-state switch between "just this one" and the whole project, shaped
 * like the dock's lock: one word that never changes ("本章"), resting glass
 * while off, the still selected glass while on. Pressed means the panel shows
 * only what belongs to the current chapter, element, material or idea.
 */
export function ScopeToggle({
  subject,
  pressed,
  disabled = false,
  onToggle,
  className = '',
}: {
  subject: ScopeToggleSubject;
  pressed: boolean;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t(`scopeToggle.subject.${subject}`);
  return (
    <button
      type="button"
      className={`scope-toggle glass glass--rest${className ? ` ${className}` : ''}`}
      aria-pressed={pressed}
      disabled={disabled}
      title={t(pressed ? 'scopeToggle.hintOn' : 'scopeToggle.hintOff', { subject: label })}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}
