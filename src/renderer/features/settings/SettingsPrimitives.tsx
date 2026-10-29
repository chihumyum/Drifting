import {
  useId,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';
import { settingsOnDesktop } from './settings-on-desktop';
import { BrushIcon, type BrushIconName } from '../../components/ui/BrushIcon';
import { Button } from '../../components/ui/Button';
import { GlassRange } from '../../components/ui/GlassRange';
import { GlassSelect } from '../../components/ui/GlassSelect';
import { GlassSlider } from '../../components/ui/GlassSlider';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Switch } from '../../components/ui/Switch';

export type SettingsRegisterRef = (element: HTMLElement | null) => void;

export function SettingsToggle({
  on,
  onChange,
  disabled = false,
  'aria-label': ariaLabel,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return <Switch checked={on} onCheckedChange={onChange} disabled={disabled} aria-label={ariaLabel} />;
}

/** One short choice out of a few: a GlassSlider on the desktop. */
export function SettingsSegment<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  if (settingsOnDesktop()) {
    return <GlassSlider value={value} options={options} onChange={onChange} ariaLabel={ariaLabel ?? ''} />;
  }
  return <SegmentedControl value={value} options={options} onChange={onChange} ariaLabel={ariaLabel} />;
}

/** A number along a track: the number slider (GlassRange) on the desktop,
 * the system slider on mobile, where `style` still applies. */
export function SettingsRange({
  value,
  min,
  max,
  step = 1,
  onChange,
  ariaLabel,
  disabled = false,
  wide = false,
  id,
  style,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  disabled?: boolean;
  wide?: boolean;
  id?: string;
  style?: CSSProperties;
}) {
  if (settingsOnDesktop()) {
    return (
      <GlassRange
        id={id}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
        ariaLabel={ariaLabel}
        disabled={disabled}
        wide={wide}
      />
    );
  }
  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(Number(event.target.value))}
      style={style}
    />
  );
}

/** A dropdown choice. On the desktop four or fewer short options (`few`) are
 * a GlassSlider and longer or entity lists a GlassSelect; mobile keeps the
 * system select. */
export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  few = false,
  disabled = false,
  width,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  ariaLabel: string;
  few?: boolean;
  disabled?: boolean;
  /** The trigger's width on the desktop and the select's on mobile. */
  width?: number;
}) {
  if (settingsOnDesktop()) {
    if (few) {
      const slider = <GlassSlider value={value} options={options} onChange={onChange} ariaLabel={ariaLabel} />;
      // GlassSlider has no disabled state of its own: while busy it fades and ignores the pointer.
      return disabled ? <span className="set-choice-disabled" aria-disabled="true">{slider}</span> : slider;
    }
    return (
      <span className="set-select-slot" style={{ width } as CSSProperties}>
        <GlassSelect value={value} options={options} onChange={onChange} ariaLabel={ariaLabel} disabled={disabled} />
      </span>
    );
  }
  return (
    <select
      className="set-input"
      style={width ? { minWidth: width } : undefined}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

const MOBILE_BUTTON: Record<'default' | 'primary' | 'danger' | 'ghost', string> = {
  default: 'set-btn',
  primary: 'set-btn set-btn--primary',
  danger: 'set-btn set-btn--danger',
  ghost: 'set-btn set-btn--ghost',
};

/** The shared Button on the desktop. `outbound` (a page that opens outside
 * Drifting) is a text button ending in the slanting arrow. */
export function SettingsButton({
  variant = 'default',
  size = 'md',
  outbound = false,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  outbound?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  if (settingsOnDesktop()) {
    return (
      <Button variant={outbound ? 'ghost' : variant} size={size} className={className} {...props}>
        {children}
        {outbound && <BrushIcon name="arrow-out" size={12} />}
      </Button>
    );
  }
  return (
    <button type="button" className={`${MOBILE_BUTTON[variant]} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}

/** A single-line field. `mono` for keys, commands, ids and paths; `meta` is
 * read at the field's end (a unit, a shortcut). */
export function SettingsField({
  mono = false,
  small = false,
  wide = false,
  meta,
  className = '',
  style,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  mono?: boolean;
  small?: boolean;
  wide?: boolean;
  meta?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}) {
  if (settingsOnDesktop()) {
    return (
      <label
        className={[
          'ui-field glass glass--rest glass--field glass--small',
          mono ? 'ui-field--mono' : '',
          small ? 'ui-field--sm' : '',
          wide ? 'set-field-wide' : '',
          className,
        ].filter(Boolean).join(' ')}
        style={style}
      >
        <input ref={ref} {...props} />
        {meta && <span className="ui-field__meta">{meta}</span>}
      </label>
    );
  }
  return (
    <input
      ref={ref}
      className={['set-input', mono ? 'set-input--mono' : '', wide ? 'set-input--wide' : '', className]
        .filter(Boolean)
        .join(' ')}
      style={style}
      {...props}
    />
  );
}

/** Several lines of NAME=value: the configuration field on the desktop. */
export function SettingsConfigField(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  if (settingsOnDesktop()) {
    return (
      <label className="ui-field ui-field--mono ui-field--config glass glass--rest glass--field set-field-wide">
        <textarea {...props} />
      </label>
    );
  }
  return <textarea className="set-input set-input--wide set-input--mono" {...props} />;
}

/** A sentence that explains, warns or reports. On the desktop it is plain
 * text after one brush icon, in the danger ink when something failed. */
export function SettingsNote({
  icon = 'status-warning',
  tone,
  role,
  className = '',
  children,
}: {
  icon?: BrushIconName;
  tone?: 'error';
  role?: 'alert' | 'status';
  className?: string;
  children: ReactNode;
}) {
  if (settingsOnDesktop()) {
    return (
      <div className={`set-note${tone === 'error' ? ' set-note--error' : ''} ${className}`.trim()} role={role}>
        <BrushIcon name={icon} size={14} />
        <div className="set-note__body">{children}</div>
      </div>
    );
  }
  return (
    <div
      className={`set-note ${className}`.trim()}
      role={role}
      style={tone === 'error' ? { color: 'hsl(var(--accent))' } : undefined}
    >
      {children}
    </div>
  );
}

/** Any colour: on the desktop a round glass button holding one seal of it
 * (or the kind's own sand mark), the value written beside. */
export function SettingsColor({
  value,
  onChange,
  ariaLabel,
  mark,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  /** A kind's sand mark in place of the plain seal. */
  mark?: ReactNode;
  /** A reset text button after the value. */
  children?: ReactNode;
}) {
  if (settingsOnDesktop()) {
    return (
      <span className="set-color">
        <label className="ui-swatch glass glass--rest glass--round">
          {mark ?? <i className="sand sand--blob-2" style={{ '--sand-c': value } as CSSProperties} />}
          <input type="color" value={value} aria-label={ariaLabel} onChange={(event) => onChange(event.target.value)} />
        </label>
        <span className="ui-swatch__value">{value.toUpperCase()}</span>
        {children}
      </span>
    );
  }
  return (
    <span className="set-color-picker">
      <input
        className="set-color-picker__input"
        type="color"
        value={value}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="set-color-picker__value">{value.toUpperCase()}</span>
      {children}
    </span>
  );
}

export function SettingsPanelHeader({
  kicker,
  title,
  sub,
}: {
  kicker: string;
  title: string;
  sub?: ReactNode;
}) {
  // The desktop drops the accent kicker: the rail already names the panel.
  return (
    <>
      {!settingsOnDesktop() && <div className="set-panel__kicker">{kicker}</div>}
      <h1 className="set-panel__title">{title}</h1>
      {sub && <p className="set-panel__sub">{sub}</p>}
    </>
  );
}

export function SettingsSectionHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  const id = useId();
  // The desktop drops the English hint that only repeats the title.
  const shownHint = settingsOnDesktop() ? undefined : hint;
  return (
    <div className="set-sec__head" id={id} data-settings-section={title}>
      <div className="set-sec__title">{title}</div>
      <div className="set-sec__head-right">
        {shownHint && <div className="set-sec__hint">{shownHint}</div>}
        {action}
      </div>
    </div>
  );
}

/** A heading above a group of sections (the Agent's usage and history). */
export function SettingsGroupHeader({ label, desc }: { label: string; desc?: string }) {
  const id = useId();
  return (
    <div className="set-group__head" id={id} data-settings-section={label}>
      <div className="set-group__title">{label}</div>
      {desc && <div className="set-group__desc">{desc}</div>}
    </div>
  );
}

export function SettingsRow({
  label,
  desc,
  control,
  top,
  stack,
}: {
  label: ReactNode;
  desc?: ReactNode;
  control?: ReactNode;
  top?: boolean;
  stack?: boolean;
}) {
  return (
    <div className={'set-row' + (top ? ' set-row--top' : '') + (stack ? ' set-row--stack' : '')}>
      <div className="set-row__main">
        <div className="set-row__label">{label}</div>
        {desc && <div className="set-row__desc">{desc}</div>}
      </div>
      {control && <div className="set-row__control">{control}</div>}
    </div>
  );
}
