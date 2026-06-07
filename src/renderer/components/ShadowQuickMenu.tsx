/**
 * ShadowQuickMenu — the bottom-bar Shadow mini-menu, mirroring CopilotBottomMenu.
 * The Shadow button used to toggle a global "shadow mode" (which re-tinted the whole
 * palette); that coupling is gone. The button now opens a compact popover with the
 * quick controls writers actually reach for:
 *   - Shadow 自动跑 — auto re-review chapters whose canon deps changed (shadowAutoRun)
 *   - 规则 — the project's freeform review rules (reuses ShadowRulesSection embedded):
 *     edit + enable inline, compiled to checklists on save
 * Room is left below for future Shadow config without a redesign.
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '../store/settings-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { ShadowRulesSection } from './dashboard/ShadowRulesSection';
import '../../styles/copilot-surface.css';

export function ShadowQuickMenu() {
  const [open, setOpen] = useState(false);
  // Button rect captured on open (reading the ref in render is disallowed). Drives
  // the portaled panel's fixed position, same as CopilotBottomMenu.
  const [rect, setRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const autoRun = useSettingsStore((s) => s.shadowAutoRun);
  const setAutoRun = useSettingsStore((s) => s.setShadowAutoRun);
  const { projectId } = useProjectNavigation();

  const toggleOpen = () => {
    setRect(buttonRef.current?.getBoundingClientRect() ?? null);
    setOpen((v) => !v);
  };

  const WIDTH = 360;
  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: rect ? window.innerHeight - rect.top + 6 : 48,
    left: rect ? Math.max(8, rect.right - WIDTH) : 8,
    zIndex: 100000,
    width: WIDTH,
    maxHeight: 'min(70vh, 560px)',
    overflowY: 'auto',
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
        className={`bsb__seg bsb__shadow${autoRun ? ' is-active' : ''}`}
        onClick={toggleOpen}
        title="Shadow"
        aria-label="Shadow"
      >
        <span
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          ◐
        </span>
        <span>Shadow</span>
      </button>

      {open &&
        createPortal(
          <>
            <div
              onMouseDown={() => setOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 99999 }}
            />
            <div onMouseDown={(e) => e.stopPropagation()} style={panelStyle}>
              <ToggleRow
                label="Shadow 自动跑"
                desc="依赖变更的已完成章节自动复审，无需手动点「复审」"
                checked={autoRun}
                onChange={setAutoRun}
              />

              <div style={{ borderTop: '1px solid var(--copilot-border-soft)', margin: '8px 0 6px' }} />
              <div style={{ fontSize: 11, color: 'var(--copilot-text-dim)', margin: '0 2px 4px' }}>
                规则
              </div>
              {projectId ? (
                <ShadowRulesSection projectId={projectId} embedded />
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    fontStyle: 'italic',
                    color: 'var(--copilot-text-dim)',
                    padding: '4px 2px',
                  }}
                >
                  打开一个项目后可编辑 Shadow 规则
                </div>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
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
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: 13, color: 'var(--copilot-text)' }}>{label}</span>
        {desc && (
          <span style={{ fontSize: 10.5, color: 'var(--copilot-text-dim)', lineHeight: 1.3 }}>
            {desc}
          </span>
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
