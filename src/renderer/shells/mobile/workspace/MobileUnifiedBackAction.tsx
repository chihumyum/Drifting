import { ArrowLeft } from 'lucide-react';
import { useInputPreservingActions } from '../../../hooks/useInputPreservingActions';

export function MobileUnifiedBackAction({
  preserveFocusUntilBack,
  onBack,
  label,
}: {
  preserveFocusUntilBack: boolean;
  onBack: () => void;
  label: string;
}) {
  const inputActions = useInputPreservingActions<HTMLButtonElement>(preserveFocusUntilBack);
  return (
    <button
      {...inputActions}
      type="button"
      className="m-unified-bar__action"
      data-debug-id="mobile-unified-back"
      onClick={onBack}
      aria-label={label}
    >
      <ArrowLeft size={20} aria-hidden="true" />
    </button>
  );
}
