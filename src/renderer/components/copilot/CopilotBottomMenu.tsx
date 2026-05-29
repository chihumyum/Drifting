/**
 * CopilotBottomMenu — the bottom-bar Copilot mini-menu (Task 2), sitting next
 * to Shadow. A compact popover with the master switch, the auto-trigger
 * switch, and per-task toggles — the same settings exposed in the full
 * Settings panel, surfaced here for quick reach while writing.
 *
 * Toggling here writes straight to the settings store (persisted), so it stays
 * in sync with the Settings modal. "更多设置" deep-links to the full panel.
 */
import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  useSettingsStore,
  COPILOT_TASKS,
  type CopilotTaskId,
  type CopilotOutputLang,
} from '../../store/settings-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';

const OUTPUT_LANG_OPTIONS: { value: CopilotOutputLang; label: string }[] = [
  { value: 'auto', label: '跟随手稿' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
];

export function CopilotBottomMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const copilotEnabled = useSettingsStore((s) => s.copilotEnabled);
  const setCopilotEnabled = useSettingsStore((s) => s.setCopilotEnabled);
  const autoTrigger = useSettingsStore((s) => s.copilotAutoTrigger);
  const setAutoTrigger = useSettingsStore((s) => s.setCopilotAutoTrigger);
  const taskConfigs = useSettingsStore((s) => s.copilotTaskConfigs);
  const setTaskEnabled = useSettingsStore((s) => s.setCopilotTaskEnabled);
  const { projectId } = useProjectNavigation();
  const outputLang =
    useSettingsStore((s) => (projectId ? s.copilotOutputLangByProject[projectId] : undefined)) ??
    'auto';
  const setOutputLang = useSettingsStore((s) => s.setCopilotOutputLang);

  // Click-away close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className={`bsb__seg bsb__shadow${copilotEnabled ? ' is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Copilot"
        aria-label="Copilot"
      >
        <Sparkles size={11} strokeWidth={1.6} />
        <span>Copilot</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            right: 0,
            zIndex: 999,
            width: 248,
            background: '#fffdf9',
            border: '1px solid rgba(184, 153, 104, 0.4)',
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(60, 40, 20, 0.18)',
            padding: 10,
            fontSize: 13,
            color: '#3a2e22',
          }}
        >
          <ToggleRow
            label="启用 Copilot"
            desc="关闭后不自动运行；⌘I 手动触发仍可用"
            checked={copilotEnabled}
            onChange={setCopilotEnabled}
          />
          <ToggleRow
            label="自动触发"
            desc="编辑时后台自动运行任务"
            checked={autoTrigger}
            onChange={setAutoTrigger}
            disabled={!copilotEnabled}
          />

          {projectId && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '5px 4px',
              }}
            >
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13, color: '#3a2e22' }}>输出语言</span>
                <span style={{ fontSize: 10.5, color: '#9a8a72', lineHeight: 1.3 }}>
                  本项目 Copilot 生成语言
                </span>
              </span>
              <select
                value={outputLang}
                onChange={(e) => setOutputLang(projectId, e.target.value as CopilotOutputLang)}
                style={{
                  fontSize: 12,
                  padding: '3px 6px',
                  borderRadius: 6,
                  border: '1px solid rgba(184, 153, 104, 0.4)',
                  background: '#fff',
                  color: '#3a2e22',
                }}
              >
                {OUTPUT_LANG_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={{ borderTop: '1px solid rgba(184, 153, 104, 0.25)', margin: '8px 0 6px' }} />
          <div style={{ fontSize: 11, color: '#9a8a72', margin: '0 2px 4px' }}>任务</div>
          {COPILOT_TASKS.map((t) => (
            <ToggleRow
              key={t.id}
              label={t.label}
              desc={t.desc}
              checked={!!taskConfigs[t.id]?.enabled}
              onChange={(on) => setTaskEnabled(t.id as CopilotTaskId, on)}
            />
          ))}

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              events.emit('settings:open', { railId: 'copilot' });
            }}
            style={{
              marginTop: 8,
              width: '100%',
              border: '1px solid rgba(184, 153, 104, 0.4)',
              borderRadius: 6,
              background: 'transparent',
              color: '#5a4a3a',
              padding: '5px 8px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            更多设置…
          </button>
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  desc,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        width: '100%',
        border: 'none',
        background: 'transparent',
        padding: '5px 4px',
        textAlign: 'left',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: 13, color: '#3a2e22' }}>{label}</span>
        {desc && (
          <span style={{ fontSize: 10.5, color: '#9a8a72', lineHeight: 1.3 }}>{desc}</span>
        )}
      </span>
      <span
        style={{
          flex: '0 0 auto',
          width: 30,
          height: 17,
          borderRadius: 999,
          background: checked ? '#7a5a3a' : 'rgba(0,0,0,0.18)',
          position: 'relative',
          transition: 'background 0.15s',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: 2,
            width: 13,
            height: 13,
            borderRadius: '50%',
            background: '#fff',
            transform: checked ? 'translateX(13px)' : 'translateX(0)',
            transition: 'transform 0.15s',
          }}
        />
      </span>
    </button>
  );
}
