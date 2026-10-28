import { useTranslation } from 'react-i18next';
import { BrushIcon } from '../../components/ui/BrushIcon';

export function TodoStatusToggle({
  resolved,
  disabled = false,
  onToggle,
}: {
  resolved: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = t(resolved ? 'commentRail.actions.reopen' : 'commentRail.actions.resolve');
  return (
    <button
      type="button"
      className="todo-status-toggle"
      aria-label={label}
      title={label}
      aria-pressed={resolved}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="todo-status-toggle__ring" aria-hidden>
        {resolved && <BrushIcon name="check" size={10} />}
      </span>
    </button>
  );
}
