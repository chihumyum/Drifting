import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnchoredPopover } from './AnchoredPopover';
import { BrushIcon } from './BrushIcon';

export interface GlassSelectOption<T extends string> {
  value: T;
  label: ReactNode;
  /** The option's sand mark (a storyline's dash, a category's corner). */
  mark?: ReactNode;
  /** Text the search field matches when `label` is not a plain string. */
  searchText?: string;
}

interface GlassSelectProps<T extends string> {
  value: T | null;
  options: readonly GlassSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  placeholder?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** Above this many options the list opens with a search field on top. */
const SEARCH_THRESHOLD = 8;

/**
 * A dropdown select for more than four choices (four or fewer short ones are
 * a GlassSlider). The trigger is a single-line field of glass ending in one
 * folding stroke; the list is a menu surface portalled to body, each option
 * with its sand mark, the current one at medium weight with a check. The
 * row the arrow keys reach keeps a still ring; the row under the pointer drifts.
 */
export function GlassSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  disabled = false,
  className = '',
}: GlassSelectProps<T>) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<T | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const current = options.find((option) => option.value === value) ?? null;
  const searchable = options.length > SEARCH_THRESHOLD;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => {
      const text = option.searchText ?? (typeof option.label === 'string' ? option.label : '');
      return text.toLowerCase().includes(needle);
    });
  }, [options, query]);

  useEffect(() => {
    if (!open) return undefined;
    // The list opens on the current option (or the search field when there is one).
    const frame = window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      const target = searchable
        ? list.querySelector<HTMLElement>('input')
        : list.querySelector<HTMLElement>('[aria-selected="true"]') ??
          list.querySelector<HTMLElement>('[role="option"]');
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, searchable]);

  const choose = (next: T) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ui-select glass glass--rest glass--field glass--small ${className}`.trim()}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (!open) {
            setQuery('');
            setWidth(triggerRef.current?.getBoundingClientRect().width);
          }
          setOpen(!open);
        }}
      >
        {current?.mark}
        <span className={`ui-select__value${current ? '' : ' ui-select__value--placeholder'}`}>
          {current ? current.label : placeholder}
        </span>
        <BrushIcon name="chevron-down" size={12} />
      </button>
      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-start"
        role="listbox"
        ariaLabel={ariaLabel}
        autoFocus={false}
        maxHeight={320}
        className="menu-surface menu-surface--rich ui-select__menu"
        style={{ zIndex: 'var(--z-modal)', width, overflowY: 'auto' }}
      >
        <div ref={listRef}>
          {searchable && (
            <div className="ui-select__search">
              <label className="ui-field ui-field--sm glass glass--rest glass--field glass--small">
                <BrushIcon name="search" size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label={t('leftSidebar.top.search')}
                />
              </label>
            </div>
          )}
          {shown.length === 0 && <div className="ui-select__empty">{t('globalSearch.noResults')}</div>}
          {shown.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`menu-surface__item${option.value === active ? ' is-current' : ''}`}
                style={{ gap: 10 }}
                onFocus={() => setActive(option.value)}
                onBlur={() => setActive((was) => (was === option.value ? null : was))}
                onClick={() => choose(option.value)}
              >
                {option.mark}
                <span style={{ flex: 1, minWidth: 0 }}>{option.label}</span>
                {selected && <BrushIcon name="check" size={13} className="ui-select__check" />}
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </>
  );
}
