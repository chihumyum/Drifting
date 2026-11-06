import {
  useId,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';
import { BrushIcon, type BrushIconName } from '../../components/ui/BrushIcon';
import { Button } from '../../components/ui/Button';
import { GlassRange } from '../../components/ui/GlassRange';
import { GlassSelect } from '../../components/ui/GlassSelect';
import { GlassSlider } from '../../components/ui/GlassSlider';
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

/** One short choice out of a few: a GlassSlider. */
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
  return <GlassSlider value={value} options={options} onChange={onChange} ariaLabel={ariaLabel ?? ''} />;
}

/** A number along a track: the number slider (GlassRange). */
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

/** A dropdown choice. Four or fewer short options (`few`) are a GlassSlider
 * and longer or entity lists a GlassSelect. */
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
  /** The trigger's width. */
  width?: number;
}) {
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

/** The shared Button. `outbound` (a page that opens outside
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
  return (
    <Button variant={outbound ? 'ghost' : variant} size={size} className={className} {...props}>
      {children}
      {outbound && <BrushIcon name="arrow-out" size={12} />}
    </Button>
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

/** Several lines of NAME=value: the configuration field. */
export function SettingsConfigField(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="ui-field ui-field--mono ui-field--config glass glass--rest glass--field set-field-wide">
      <textarea {...props} />
    </label>
  );
}

/** A sentence that explains, warns or reports: plain text after one brush
 * icon, in the danger ink when something failed. */
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
  return (
    <div className={`set-note${tone === 'error' ? ' set-note--error' : ''} ${className}`.trim()} role={role}>
      <BrushIcon name={icon} size={14} />
      <div className="set-note__body">{children}</div>
    </div>
  );
}

// Preferences and entity editors use the same native colour control.
export { ColorPicker as SettingsColor } from '../../components/ui/ColorPicker';

export function SettingsPanelHeader({
  title,
  sub,
}: {
  /** Not drawn: the rail already names the panel. */
  kicker: string;
  title: string;
  sub?: ReactNode;
}) {
  return (
    <>
      <h1 className="set-panel__title">{title}</h1>
      {sub && <p className="set-panel__sub">{sub}</p>}
    </>
  );
}

export function SettingsSectionHeader({
  title,
  action,
}: {
  title: string;
  /** Not drawn: the English hint only repeats the title. */
  hint?: string;
  action?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="set-sec__head" id={id} data-settings-section={title}>
      <div className="set-sec__title">{title}</div>
      <div className="set-sec__head-right">
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
