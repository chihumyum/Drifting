import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { AnchoredPopover } from './AnchoredPopover';

interface RelationKindFieldProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  resolveOptionColor: (option: string) => string;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  inputClassName?: string;
  inputStyle?: CSSProperties;
  ariaLabel?: string;
  onSubmit?: () => void;
}

/**
 * Shared free-form relation-kind input. Suggestions live in a body portal so
 * modal/card overflow can never clip them; the input remains the focus owner
 * while a suggestion is chosen with the pointer.
 */
export function RelationKindField({
  value,
  onChange,
  options,
  resolveOptionColor,
  placeholder,
  autoFocus,
  className = '',
  inputClassName,
  inputStyle,
  ariaLabel = 'Relation kinds',
  onSubmit,
}: RelationKindFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [anchorWidth, setAnchorWidth] = useState(320);
  const matches = useMemo(() => {
    const filter = value.trim().toLowerCase();
    const uniqueOptions = [...new Set(options)];
    return filter
      ? uniqueOptions.filter((option) => option.toLowerCase().includes(filter))
      : uniqueOptions;
  }, [options, value]);
  const open = suggestionsOpen && matches.length > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && onSubmit) {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (suggestionsOpen) setSuggestionsOpen(false);
    else event.currentTarget.blur();
  };

  return (
    <div className={className}>
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        type="text"
        className={inputClassName}
        style={inputStyle}
        value={value}
        placeholder={placeholder}
        aria-autocomplete="list"
        aria-expanded={open}
        onFocus={(event) => {
          setAnchorWidth(event.currentTarget.getBoundingClientRect().width);
          setSuggestionsOpen(true);
        }}
        onBlur={() => setSuggestionsOpen(false)}
        onChange={(event) => {
          onChange(event.target.value);
          setSuggestionsOpen(true);
        }}
        onKeyDown={handleKeyDown}
      />
      <AnchoredPopover
        anchorRef={inputRef}
        open={open}
        onClose={() => setSuggestionsOpen(false)}
        placement="bottom-start"
        offset={4}
        role="listbox"
        ariaLabel={ariaLabel}
        autoFocus={false}
        restoreFocus={false}
        dismissOnEscape={false}
        maxHeight={180}
        className="relation-kind-suggestions"
        style={{ width: anchorWidth }}
      >
        {matches.map((option) => (
          <button
            key={option}
            type="button"
            role="option"
            aria-selected={value === option}
            className="relation-kind-suggestions__option"
            onMouseDown={(event) => {
              event.preventDefault();
              onChange(option);
              setSuggestionsOpen(false);
            }}
          >
            <span
              className="relation-kind-suggestions__marker"
              style={{ background: resolveOptionColor(option) }}
            />
            <span>{option}</span>
          </button>
        ))}
      </AnchoredPopover>
    </div>
  );
}
