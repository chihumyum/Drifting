/**
 * CopilotBottomMenu — the bottom-bar Copilot mini-menu (Task 2), sitting next
 * to Shadow. A compact popover with the master switch, the auto-trigger
 * switch, and per-task toggles — the same settings exposed in the full
 * Settings panel, surfaced here for quick reach while writing.
 *
 * Toggling here writes straight to the settings store (persisted), so it stays
 * in sync with the Settings modal. "更多设置" deep-links to the full panel.
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import {
  useSettingsStore,
  COPILOT_TASKS,
  type CopilotTaskId,
  type CopilotOutputLang,
} from '../../store/settings-store';
import { getCopilotCapability } from '../../lib/copilot/capability';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { events } from '../../lib/events';
import '../../../styles/copilot-surface.css';

const OUTPUT_LANG_OPTIONS: { value: CopilotOutputLang; label: string }[] = [
  { value: 'auto', label: 'Follow manuscript' },
  { value: 'zh-CN', label: 'Simplified Chinese' },
  { value: 'zh-TW', label: 'Traditional Chinese' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
];

export function CopilotBottomMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Button rect captured on open (in the click handler — reading the ref in
  // render is disallowed). Drives the portaled panel's fixed position.
  const [rect, setRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const toggleOpen = () => {
    setRect(buttonRef.current?.getBoundingClientRect() ?? null);
    setOpen((v) => !v);
  };

  const autoTrigger = useSettingsStore((s) => s.copilotAutoTrigger);
  const setAutoTrigger = useSettingsStore((s) => s.setCopilotAutoTrigger);
  const { projectId } = useProjectNavigation();
  const outputLang =
    useSettingsStore((s) => (projectId ? s.copilotOutputLangByProject[projectId] : undefined)) ??
    'auto';
  const setOutputLang = useSettingsStore((s) => s.setCopilotOutputLang);

  // Panel position: anchored above the button, computed from its captured
  // rect. The panel is portaled to <body> with a high z-index so the editor
  // floating island can't paint over it.
  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: rect ? window.innerHeight - rect.top + 6 : 48,
    left: rect ? Math.max(8, rect.right - 248) : 8,
    zIndex: 'var(--z-toast)',
    width: 248,
    background: 'var(--copilot-surface)',
    border: '1px solid var(--copilot-border)',
    borderRadius: 'var(--copilot-radius)',
    boxShadow: '0 12px 32px var(--copilot-shadow)',
    padding: 10,
    fontSize: 13,
    color: 'var(--copilot-text)',
  };

  return (
    <div style={{ display: 'inline-flex' }}>
      <button
        ref={buttonRef}
        type="button"
        className={`bsb__seg bsb__copilot${autoTrigger ? ' is-live' : ''}`}
        onClick={toggleOpen}
        title="Copilot"
        aria-label="Copilot"
      >
        <Sparkles size={11} strokeWidth={1.6} />
        <span>Copilot</span>
      </button>

      {open &&
        createPortal(
          <>
            <div
              onMouseDown={() => setOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 'calc(var(--z-toast) - 1)' }}
            />
            <div onMouseDown={(e) => e.stopPropagation()} style={panelStyle}>
          <ToggleRow
            label={t('settings.copilot.autoTrigger')}
            desc={t('settings.copilot.autoTriggerDesc')}
            checked={autoTrigger}
            onChange={setAutoTrigger}
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
                <span style={{ fontSize: 13, color: 'var(--copilot-text)' }}>{t('settings.copilot.outputLang')}</span>
                <span style={{ fontSize: 10.5, color: 'var(--copilot-text-dim)', lineHeight: 1.3 }}>
                  {t('settings.copilot.outputLangDesc')}
                </span>
              </span>
              <select
                value={outputLang}
                onChange={(e) => setOutputLang(projectId, e.target.value as CopilotOutputLang)}
                className="copilot-field"
                style={{
                  fontSize: 12,
                  padding: '3px 6px',
                  borderRadius: 'var(--copilot-radius-sm)',
                  border: '1px solid var(--copilot-border)',
                  background: 'var(--copilot-field-bg)',
                  color: 'var(--copilot-text)',
                }}
              >
                {OUTPUT_LANG_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(`settings.copilot.outputLangOptions.${o.value}`, { defaultValue: o.label })}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--copilot-border-soft)', margin: '8px 0 6px' }} />
          <div style={{ fontSize: 11, color: 'var(--copilot-text-dim)', margin: '0 2px 4px' }}>
            {t('settings.copilot.tasksTitle')}
          </div>
          {COPILOT_TASKS.map((task) => (
            <TaskRow
              key={task.id}
              taskId={task.id}
              label={t(`settings.copilot.tasks.${task.id}.label`, { defaultValue: task.label })}
              desc={t(`settings.copilot.tasks.${task.id}.desc`, { defaultValue: task.desc })}
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
              border: '1px solid var(--copilot-border)',
              borderRadius: 'var(--copilot-radius-sm)',
              background: 'transparent',
              color: 'var(--copilot-text)',
              padding: '5px 8px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {t('settings.copilot.moreSettings')}
          </button>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

const DEBOUNCE_MIN_SEC = 1;
const DEBOUNCE_MAX_SEC = 60;

/**
 * One auto-task row: enable toggle + (when wired & enabled) a compact debounce
 * slider. Same store fields as the Settings panel's CopilotTaskRow, so the two
 * surfaces stay in sync.
 */
function TaskRow({ taskId, label, desc }: { taskId: CopilotTaskId; label: string; desc: string }) {
  const { t } = useTranslation();
  const cfg = useSettingsStore((s) => s.copilotTaskConfigs[taskId]);
  const setEnabled = useSettingsStore((s) => s.setCopilotTaskEnabled);
  const setDebounceMs = useSettingsStore((s) => s.setCopilotTaskDebounceMs);

  const cap = getCopilotCapability(taskId);
  const enabled = cfg?.enabled ?? false;
  const effectiveMs = cfg?.debounceMs ?? cap?.defaultDebounceMs ?? 5000;
  const effectiveSec = Math.round(effectiveMs / 1000);

  return (
    <div>
      <ToggleRow label={label} desc={desc} checked={enabled} onChange={(on) => setEnabled(taskId, on)} />
      {cap && enabled && (
        <div style={{ padding: '0 4px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={DEBOUNCE_MIN_SEC}
            max={DEBOUNCE_MAX_SEC}
            step={1}
            value={Math.min(DEBOUNCE_MAX_SEC, Math.max(DEBOUNCE_MIN_SEC, effectiveSec))}
            onChange={(e) => setDebounceMs(taskId, parseInt(e.target.value, 10) * 1000)}
            style={{ flex: 1, minWidth: 0, accentColor: 'var(--copilot-accent)', height: 12 }}
            title={t('settings.copilot.debounceTitle')}
          />
          <span
            style={{
              flex: '0 0 auto',
              fontSize: 10.5,
              fontFamily: 'var(--font-mono)',
              color: 'var(--copilot-text-dim)',
              minWidth: 30,
              textAlign: 'right',
            }}
          >
            {effectiveSec}s
          </span>
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
        <span style={{ fontSize: 13, color: 'var(--copilot-text)' }}>{label}</span>
        {desc && (
          <span style={{ fontSize: 10.5, color: 'var(--copilot-text-dim)', lineHeight: 1.3 }}>{desc}</span>
        )}
      </span>
      <span
        style={{
          flex: '0 0 auto',
          width: 30,
          height: 17,
          borderRadius: 999,
          background: checked ? 'var(--copilot-accent)' : 'var(--copilot-toggle-off)',
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
            background: 'var(--copilot-knob)',
            transform: checked ? 'translateX(13px)' : 'translateX(0)',
            transition: 'transform 0.15s',
          }}
        />
      </span>
    </button>
  );
}
