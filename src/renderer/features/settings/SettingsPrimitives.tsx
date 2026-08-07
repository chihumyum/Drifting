import type { ReactNode } from 'react';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Switch } from '../../components/ui/Switch';

export type SettingsRegisterRef = (element: HTMLElement | null) => void;

export function SettingsToggle({
  on,
  onChange,
  disabled = false,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return <Switch checked={on} onCheckedChange={onChange} disabled={disabled} />;
}

export function SettingsSegment<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return <SegmentedControl value={value} options={options} onChange={onChange} />;
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
  return (
    <>
      <div className="set-panel__kicker">{kicker}</div>
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
  return (
    <div className="set-sec__head">
      <div className="set-sec__title">{title}</div>
      <div className="set-sec__head-right">
        {hint && <div className="set-sec__hint">{hint}</div>}
        {action}
      </div>
    </div>
  );
}

export function SettingsGroupHeader({
  label,
  hint,
  desc,
}: {
  label: string;
  hint?: string;
  desc?: string;
}) {
  return (
    <div style={{ margin: '26px 0 6px', paddingTop: 18, borderTop: '1px solid hsl(var(--rule))' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'hsl(var(--ink-1))' }}>{label}</div>
        {hint && (
          <div
            style={{
              color: 'hsl(var(--ink-4))',
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            {hint}
          </div>
        )}
      </div>
      {desc && (
        <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.6, opacity: 0.7 }}>{desc}</div>
      )}
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
