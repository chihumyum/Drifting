/**
 * CopilotInlinePopover — the ⌘I / context-menu "输入框 + 菜单二合一" surface
 * (Tasks 4/6/7). One unified entry, with or without a selection:
 *
 *   • Input box (always shown): a free-text prompt. Pressing Enter (or 局部修改)
 *     runs inline-edit on the target — the selection, or the current block when
 *     there's no selection. Local revision only; refuses new-content unless the
 *     author opted in. Result previews inline; accept applies it in place.
 *   • Quick chips: prefill + run inline-edit for the common asks.
 *   • Task menu: the other Copilot capabilities (element extract / patch). These
 *     are BLOCK-scoped — they run on the rolling/coverage context via the
 *     manual-run engine, carrying whatever prompt is in the box as a steer, and
 *     their results land in the margin (批注). NOT chapter-scoped.
 *
 * (Chapter-scoped "本章运行" actions like reverse-summary attach here once built.)
 *
 * Mounted per ChapterEditor; renders only when the store's ctx.nodeId matches.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useCopilotInlineStore, type CopilotInlineCtx } from '../../store/copilot-inline-store';
import { useSettingsStore, COPILOT_TASKS } from '../../store/settings-store';
import { capabilitiesForTrigger } from '../../lib/copilot/capability';
import {
  runInlineEdit,
  applyInlineEdit,
  type InlineEditResult,
} from '../../lib/copilot/inline-edit';
import { events } from '../../lib/events';

const QUICK_CHIPS = ['修复语病', '换个说法', '更准的词', '强化通感', '更精炼'];

type Phase = 'input' | 'running' | 'result' | 'refused' | 'error';

interface CopilotInlinePopoverProps {
  editor: Editor;
  nodeId: string;
}

export function CopilotInlinePopover({ editor, nodeId }: CopilotInlinePopoverProps) {
  const ctx = useCopilotInlineStore((s) => s.ctx);
  const close = useCopilotInlineStore((s) => s.close);
  const allowNewContent = useSettingsStore((s) => s.copilotInlineEditAllowNewContent);
  const taskConfigs = useSettingsStore((s) => s.copilotTaskConfigs);

  const visible = !!ctx && ctx.nodeId === nodeId;

  const [instruction, setInstruction] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [result, setResult] = useState<InlineEditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Block-scoped capabilities the user can manually run with the typed prompt.
  const menuCaps = useMemo(() => capabilitiesForTrigger('editor-block-debounced'), []);
  const taskLabel = useCallback(
    (id: string) => COPILOT_TASKS.find((t) => t.id === id)?.label ?? id,
    [],
  );

  // Reset to a fresh input state on each new invocation (render-phase reset —
  // the "adjust state when a prop changes" pattern, not an effect).
  const [seenCtx, setSeenCtx] = useState<CopilotInlineCtx | null>(null);
  if (visible && seenCtx !== ctx) {
    setSeenCtx(ctx);
    setInstruction('');
    setPhase('input');
    setResult(null);
    setError(null);
  }

  // Focus the input when the popover opens.
  useEffect(() => {
    if (visible && phase === 'input') {
      const id = setTimeout(() => textareaRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [visible, ctx, phase]);

  // Abort any in-flight call when the popover unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const doClose = useCallback(() => {
    abortRef.current?.abort();
    close();
  }, [close]);

  const runEdit = useCallback(
    async (instr: string) => {
      if (!ctx || !instr.trim()) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPhase('running');
      setError(null);
      try {
        const r = await runInlineEdit({
          target: {
            from: ctx.from,
            to: ctx.to,
            selectedText: ctx.selectedText,
            blockContext: ctx.blockContext,
            nearbyContext: ctx.nearbyContext || undefined,
          },
          instruction: instr.trim(),
          allowNewContent,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setResult(r);
        setPhase(r.refused ? 'refused' : 'result');
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    },
    [ctx, allowNewContent],
  );

  const acceptResult = useCallback(() => {
    if (!result) return;
    const ok = applyInlineEdit(editor, result);
    if (!ok) {
      setError('选区已发生变化，无法应用修改。');
      setPhase('error');
      return;
    }
    close();
  }, [result, editor, close]);

  // Run a block-scoped capability via the manual-run engine, carrying the
  // typed prompt as a steer. Results land in the margin; close the popover.
  const runCapability = useCallback(
    (capId: string) => {
      if (!ctx) return;
      events.emit('copilot:manual-run', {
        nodeId: ctx.nodeId,
        capId,
        instruction: instruction.trim() || undefined,
      });
      close();
    },
    [ctx, instruction, close],
  );

  // Esc closes; Enter accepts a ready result.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        doClose();
      } else if (e.key === 'Enter' && phase === 'result') {
        e.preventDefault();
        acceptResult();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible, phase, doClose, acceptResult]);

  if (!visible || !ctx) return null;

  const left = Math.min(ctx.clientX, window.innerWidth - 380);
  const top = Math.min(ctx.clientY + 8, window.innerHeight - 340);
  const targetHint = ctx.mode === 'selection' ? '将修改选中的文字' : '将修改光标所在段落';

  return (
    <>
      <div onMouseDown={doClose} style={{ position: 'fixed', inset: 0, zIndex: 998 }} />
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: Math.max(8, left),
          top: Math.max(8, top),
          zIndex: 999,
          width: 360,
          background: '#fffdf9',
          border: '1px solid rgba(184, 153, 104, 0.4)',
          borderRadius: 10,
          boxShadow: '0 12px 32px rgba(60, 40, 20, 0.18)',
          padding: 12,
          fontSize: 13,
          color: '#3a2e22',
        }}
      >
        {phase === 'input' && (
          <div>
            <textarea
              ref={textareaRef}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void runEdit(instruction);
                }
              }}
              placeholder="想怎么改？例如：修复语病、换个更准的动词……（不生成新情节）"
              rows={2}
              style={{
                width: '100%',
                resize: 'none',
                border: '1px solid rgba(184, 153, 104, 0.35)',
                borderRadius: 6,
                padding: '6px 8px',
                fontSize: 13,
                outline: 'none',
                background: '#fff',
                fontFamily: 'inherit',
              }}
            />
            <div style={{ fontSize: 11, color: '#9a8a72', marginTop: 4 }}>{targetHint}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
              {QUICK_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => {
                    setInstruction(chip);
                    void runEdit(chip);
                  }}
                  style={chipStyle}
                >
                  {chip}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
              <button
                type="button"
                onClick={() => void runEdit(instruction)}
                disabled={!instruction.trim()}
                style={{ ...primaryBtn, opacity: instruction.trim() ? 1 : 0.45 }}
              >
                局部修改 <kbd style={kbdStyle}>↵</kbd>
              </button>
              <button type="button" onClick={doClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
                关闭 <kbd style={kbdStyle}>Esc</kbd>
              </button>
            </div>

            {menuCaps.length > 0 && (
              <div style={{ borderTop: '1px solid rgba(184, 153, 104, 0.25)', marginTop: 10, paddingTop: 8 }}>
                <div style={{ fontSize: 11, color: '#9a8a72', marginBottom: 4 }}>
                  用上面的提示运行任务（结果进批注）
                </div>
                {menuCaps.map((cap) => {
                  const off = !taskConfigs[cap.id as keyof typeof taskConfigs]?.enabled;
                  return (
                    <button
                      key={cap.id}
                      type="button"
                      onClick={() => runCapability(cap.id)}
                      style={menuItemStyle}
                    >
                      <span>{taskLabel(cap.id)}</span>
                      {off && <span style={{ fontSize: 10, color: '#b0a088' }}>已关闭 · 单次运行</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {phase === 'running' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px' }}>
            <span style={spinnerStyle} />
            <span style={{ color: '#6a5b48' }}>正在修改……</span>
            <button type="button" onClick={doClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
              取消
            </button>
          </div>
        )}

        {phase === 'result' && result && (
          <div>
            <div style={previewLabel}>原文</div>
            <div style={{ ...previewBox, color: '#8a7860', textDecoration: 'line-through', opacity: 0.6 }}>
              {result.originalText}
            </div>
            <div style={{ ...previewLabel, marginTop: 6 }}>修改后</div>
            <div style={{ ...previewBox, background: 'rgba(120, 160, 110, 0.12)' }}>
              {result.editedText}
            </div>
            {result.reason && (
              <div style={{ fontSize: 11, color: '#8a7860', marginTop: 6 }}>{result.reason}</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" onClick={acceptResult} style={primaryBtn}>
                接受 <kbd style={kbdStyle}>↵</kbd>
              </button>
              <button type="button" onClick={() => setPhase('input')} style={ghostBtn}>
                重写
              </button>
              <button type="button" onClick={doClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
                放弃
              </button>
            </div>
          </div>
        )}

        {phase === 'refused' && result && (
          <div>
            <div style={{ color: '#a65a3a', fontWeight: 600, marginBottom: 4 }}>未执行</div>
            <div style={{ color: '#6a5b48' }}>{result.reason}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" onClick={() => setPhase('input')} style={ghostBtn}>
                换个指令
              </button>
              <button type="button" onClick={doClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
                关闭
              </button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div>
            <div style={{ color: '#a65a3a', fontWeight: 600, marginBottom: 4 }}>出错了</div>
            <div style={{ color: '#6a5b48', wordBreak: 'break-word' }}>{error}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" onClick={() => setPhase('input')} style={ghostBtn}>
                重试
              </button>
              <button type="button" onClick={doClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const chipStyle: React.CSSProperties = {
  border: '1px solid rgba(184, 153, 104, 0.4)',
  borderRadius: 999,
  background: '#fff',
  padding: '2px 9px',
  fontSize: 12,
  color: '#5a4a3a',
  cursor: 'pointer',
};

const kbdStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 11,
  background: 'rgba(0,0,0,0.06)',
  borderRadius: 4,
  padding: '0 4px',
};

const spinnerStyle: React.CSSProperties = {
  width: 13,
  height: 13,
  border: '2px solid rgba(184, 153, 104, 0.35)',
  borderTopColor: '#9a7a4a',
  borderRadius: '50%',
  display: 'inline-block',
  animation: 'copilot-inline-spin 0.7s linear infinite',
};

const previewLabel: React.CSSProperties = { fontSize: 11, color: '#9a8a72' };
const previewBox: React.CSSProperties = {
  border: '1px solid rgba(184, 153, 104, 0.25)',
  borderRadius: 6,
  padding: '5px 8px',
  marginTop: 2,
  whiteSpace: 'pre-wrap',
  lineHeight: 1.5,
};

const primaryBtn: React.CSSProperties = {
  border: 'none',
  borderRadius: 6,
  background: '#7a5a3a',
  color: '#fff',
  padding: '5px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

const ghostBtn: React.CSSProperties = {
  border: '1px solid rgba(184, 153, 104, 0.4)',
  borderRadius: 6,
  background: 'transparent',
  color: '#5a4a3a',
  padding: '5px 10px',
  fontSize: 12,
  cursor: 'pointer',
};

const menuItemStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
  border: 'none',
  background: 'transparent',
  padding: '5px 4px',
  fontSize: 13,
  color: '#3a2e22',
  cursor: 'pointer',
  textAlign: 'left',
};
