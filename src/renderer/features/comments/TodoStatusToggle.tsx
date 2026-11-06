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
  // A round glass button; done is its selected glass with the brush tick
  // drawn in.
  return (
    <button
      type="button"
      className="todo-status-toggle todo-status-toggle--glass glass glass--round glass--rest"
      aria-label={label}
      title={label}
      aria-pressed={resolved}
      disabled={disabled}
      onClick={onToggle}
    >
      <BrushIcon name="check" size={13} className="todo-status-toggle__tick" />
    </button>
  );
}
