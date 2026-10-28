import { forwardRef, type ChangeEventHandler, type KeyboardEventHandler } from 'react';
import { BrushIcon } from '../ui/BrushIcon';

interface FindToolbarProps {
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
  placeholder: string;
  stats: string;
  noMatches: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  previousTitle: string;
  nextTitle: string;
  closeTitle: string;
}

export const FindToolbar = forwardRef<HTMLInputElement, FindToolbarProps>(function FindToolbar(
  {
    value,
    onChange,
    onKeyDown,
    placeholder,
    stats,
    noMatches,
    onPrevious,
    onNext,
    onClose,
    previousTitle,
    nextTitle,
    closeTitle,
  },
  ref,
) {
  return (
    <div className="editor-find-panel">
      <input
        ref={ref}
        className="editor-find-input"
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
      />
      <span className="editor-find-stats">{stats}</span>
      <button
        type="button"
        className="editor-find-btn"
        onClick={onPrevious}
        disabled={noMatches}
        title={previousTitle}
        aria-label={previousTitle}
      >
        <BrushIcon name="chevron-up" size={14} />
      </button>
      <button
        type="button"
        className="editor-find-btn"
        onClick={onNext}
        disabled={noMatches}
        title={nextTitle}
        aria-label={nextTitle}
      >
        <BrushIcon name="chevron-down" size={14} />
      </button>
      <button
        type="button"
        className="editor-find-btn"
        onClick={onClose}
        title={closeTitle}
        aria-label={closeTitle}
      >
        <BrushIcon name="close" size={14} />
      </button>
    </div>
  );
});
