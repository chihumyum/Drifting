import { forwardRef, type ChangeEventHandler, type KeyboardEventHandler } from 'react';
import { BrushIcon } from '../ui/BrushIcon';
import { GhostIconButton } from '../ui/GhostIconButton';

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

/** The find bar: a floating layer in the menu shell, the query in a field of
 * glass with the count at its end, then flat previous / next / close. */
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
      <label className="ui-field glass glass--rest glass--field glass--small">
        <input
          ref={ref}
          className="editor-find-input"
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
        />
        <span className="ui-field__meta editor-find-stats">{stats}</span>
      </label>
      <GhostIconButton
        icon={<BrushIcon name="chevron-up" size={14} />}
        onClick={onPrevious}
        disabled={noMatches}
        title={previousTitle}
        aria-label={previousTitle}
      />
      <GhostIconButton
        icon={<BrushIcon name="chevron-down" size={14} />}
        onClick={onNext}
        disabled={noMatches}
        title={nextTitle}
        aria-label={nextTitle}
      />
      <GhostIconButton
        icon={<BrushIcon name="close" size={14} />}
        onClick={onClose}
        title={closeTitle}
        aria-label={closeTitle}
      />
    </div>
  );
});
