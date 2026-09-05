import { ArrowLeft } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

export function MobileUnifiedBackAction({
  preserveFocusUntilBack,
  onBack,
  label,
}: {
  preserveFocusUntilBack: boolean;
  onBack: () => void;
  label: string;
}) {
  if (!preserveFocusUntilBack) {
    return (
      <button
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

  const keepEditorFocused = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onBack();
  };
  const handleClick = (event: ReactMouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.detail === 0) onBack();
  };

  return (
    <span
      role="button"
      className="m-unified-bar__action"
      data-debug-id="mobile-unified-back"
      onPointerDown={keepEditorFocused}
      onMouseDown={(event) => event.preventDefault()}
      onPointerUp={handlePointerUp}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onBack();
      }}
      onClick={handleClick}
      aria-label={label}
    >
      <ArrowLeft size={20} aria-hidden="true" />
    </span>
  );
}
