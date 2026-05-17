import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  SHORTCUT_ACTIONS,
  useShortcutsStore,
  type ShortcutActionId,
} from '../../store/shortcuts-store';
import { acceleratorFromEvent, formatAccelerator } from '../../lib/shortcuts';

export function ShortcutsSettings() {
  const bindings = useShortcutsStore((s) => s.bindings);
  const setBinding = useShortcutsStore((s) => s.setBinding);
  const resetBinding = useShortcutsStore((s) => s.resetBinding);
  const resetAll = useShortcutsStore((s) => s.resetAll);
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recordingRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Always swallow keys while recording so the new accelerator doesn't
      // also trigger something else (or close the modal via Escape).
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setRecording(null);
        setError(null);
        return;
      }

      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return; // modifier-only press, keep listening

      // Reject conflicts with another action's binding.
      const conflict = (Object.entries(bindings) as [ShortcutActionId, string][]).find(
        ([id, accel]) => id !== recording && accel === accelerator,
      );
      if (conflict) {
        const def = SHORTCUT_ACTIONS.find((a) => a.id === conflict[0]);
        setError(`${formatAccelerator(accelerator)} 已被「${def?.label ?? conflict[0]}」占用`);
        return;
      }

      setBinding(recording, accelerator);
      setRecording(null);
      setError(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, bindings, setBinding]);

  return (
    <div>
      <p
        style={{
          fontSize: 13,
          color: '#8b7355',
          marginBottom: 16,
        }}
      >
        点击右侧的快捷键按钮进入录制模式，按下新的组合键即可重新绑定。按 Esc 取消录制。
      </p>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          border: '1px solid #e8dcc8',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {SHORTCUT_ACTIONS.map((action, idx) => {
          const accel = bindings[action.id];
          const isRecording = recording === action.id;
          return (
            <div
              key={action.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                background: idx % 2 === 0 ? '#fefdfb' : '#f9f6f1',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: '#2a1a0a', fontWeight: 500 }}>
                  {action.label}
                </div>
                <div style={{ fontSize: 12, color: '#8b7355', marginTop: 2 }}>
                  {action.description}
                </div>
              </div>
              <button
                ref={isRecording ? recordingRef : undefined}
                onClick={() => {
                  setError(null);
                  setRecording(isRecording ? null : action.id);
                }}
                style={{
                  minWidth: 110,
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: isRecording ? '2px dashed #b89968' : '1px solid #e8dcc8',
                  background: isRecording ? '#fff7ec' : '#fff',
                  color: '#3a2a1a',
                  fontSize: 13,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
              >
                {isRecording ? '按下新组合键…' : formatAccelerator(accel)}
              </button>
              <button
                onClick={() => resetBinding(action.id)}
                title="恢复默认"
                style={{
                  width: 28,
                  height: 28,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  background: 'transparent',
                  color: '#8b7355',
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
              >
                <RotateCcw size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {error && (
        <div style={{ marginTop: 12, color: '#a14a3a', fontSize: 13 }}>{error}</div>
      )}

      <div style={{ marginTop: 16 }}>
        <button
          onClick={resetAll}
          style={{
            padding: '8px 14px',
            border: '1px solid #e8dcc8',
            borderRadius: 6,
            background: 'transparent',
            color: '#5a4a3a',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          恢复所有快捷键默认值
        </button>
      </div>
    </div>
  );
}
