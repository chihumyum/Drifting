import { Fragment } from 'react';
import { Check } from 'lucide-react';
import { AnchoredPopover } from '../ui/AnchoredPopover';

export interface SortMenuOption<T extends string> {
  value: T;
  label: string;
}

// A radio group rendered below the primary sort group, separated by a divider.
// Used for extra per-panel toggles that live in this same menu but are a
// different dimension from the sort order (e.g. the node cell's right-edge meta,
// or the storyline view's "仅主线分组显示" duplicate-chapter switch). Values are
// type-erased to string at this boundary — build groups with `sortMenuGroup` to
// keep option/value/onChange agreeing on the same union at the call site.
export interface SortMenuGroup {
  title?: string;
  options: SortMenuOption<string>[];
  value: string;
  onChange: (next: string) => void;
}

// Typed constructor for a SortMenuGroup. The erasure to string happens here once
// (inside the cast) instead of leaking a cast into every call site.
export function sortMenuGroup<S extends string>(group: {
  title?: string;
  options: SortMenuOption<S>[];
  value: S;
  onChange: (next: S) => void;
}): SortMenuGroup {
  // onChange is contravariant in S, so the narrowing to (string) => void isn't
  // structurally sound to TS — but SortMenu only ever calls it with one of this
  // group's own option values, so the erasure is safe in practice.
  return group as unknown as SortMenuGroup;
}

interface SortMenuProps<T extends string> {
  triggerRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  options: SortMenuOption<T>[];
  value: T;
  onChange: (next: T) => void;
  title?: string;
  // Optional extra radio groups rendered below a divider — separate dimensions
  // from the sort order that share this same menu.
  groups?: SortMenuGroup[];
}

// Small radio-style popover anchored under a trigger button. Used by the
// left sidebar sub-header to switch each panel's sort mode. Mirrors UserMenu's
// shared portal / viewport-clamp / Escape pattern so dismissal matches.
export function SortMenu<T extends string>({
  triggerRef,
  open,
  onClose,
  options,
  value,
  onChange,
  title,
  groups,
}: SortMenuProps<T>) {
  const extraGroups = (groups ?? []).filter((g) => g.options.length > 0);

  return (
    <AnchoredPopover
      anchorRef={triggerRef}
      open={open}
      onClose={onClose}
      placement="bottom-end"
      role="menu"
      maxHeight={480}
      className="menu-surface menu-surface--compact sort-menu"
      style={{ zIndex: 'var(--z-popover)' }}
    >
      {title && <GroupTitle>{title}</GroupTitle>}

      <div>
        {options.map((opt) => (
          <SortMenuRow
            key={opt.value}
            label={opt.label}
            active={opt.value === value}
            onSelect={() => {
              onChange(opt.value);
              onClose();
            }}
          />
        ))}
      </div>

      {extraGroups.map((group, i) => (
        <Fragment key={group.title ?? i}>
          <div className="menu-surface__divider" />
          {group.title && <GroupTitle>{group.title}</GroupTitle>}
          <div>
            {group.options.map((opt) => (
              <SortMenuRow
                key={opt.value}
                label={opt.label}
                active={opt.value === group.value}
                onSelect={() => {
                  group.onChange(opt.value);
                  onClose();
                }}
              />
            ))}
          </div>
        </Fragment>
      ))}
    </AnchoredPopover>
  );
}

function GroupTitle({ children }: { children: React.ReactNode }) {
  return <div className="menu-surface__section-label">{children}</div>;
}

function SortMenuRow({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onSelect}
      className="menu-surface__item"
      style={{
        gap: 8,
      }}
    >
      <span
        style={{
          width: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'hsl(var(--accent))',
          flexShrink: 0,
        }}
      >
        {active ? <Check size={12} strokeWidth={2.2} /> : null}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflowWrap: 'anywhere',
          fontWeight: active ? 500 : 400,
        }}
      >
        {label}
      </span>
    </button>
  );
}
