/**
 * CopilotInlinePopover — the ⇧⌘I / context-menu "输入框 + 菜单二合一" surface
 * (Tasks 4/6/7). One unified entry, with or without a selection.
 *
 * Input box (always shown): a free-text prompt. The action list below is one
 * keyboard-navigable menu (↑/↓ to move, ⏎ to run the highlighted item); the
 * default item is the local-edit, so typing + ⏎ runs inline-edit. An empty
 * box does nothing on ⏎ (the user supplies the instruction).
 *
 * Actions are grouped by scenario:
 *   - No selection: 「在光标处触发」(local edit only) + 「本章节触发」(chapter
 *     summary).
 *   - Selection:    「对选中的文本触发」(local edit + element extract/patch) +
 *     「本章节触发」(chapter summary — selection-independent).
 * Capability runs land in the margin (批注); inline-edit previews inline.
 *
 * Mounted per ChapterEditor; renders only when the store's ctx.nodeId matches.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useCopilotInlineStore, type CopilotInlineCtx } from '../../store/copilot-inline-store';
import { useSettingsStore, COPILOT_TASKS } from '../../store/settings-store';
import { capabilitiesForTrigger } from '../../lib/copilot/capability';
import {
  runInlineEdit,
  applyInlineEdit,
  type InlineEditResult,
} from '../../lib/copilot/inline-edit';
import { generateChapterSummary } from '../../lib/copilot/reverse-chapter-summary';
import { events } from '../../lib/events';

const PANEL_WIDTH = 360;
const VIEWPORT_MARGIN = 8;

type Phase = 'input' | 'running' | 'result' | 'refused' | 'error';

/** One row in the unified action menu. */
interface Action {
  key: string;
  kind: 'inline' | 'cap' | 'chapter';
  capId?: string;
  label: string;
  note?: string;
  group: string;
}

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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('input');
  const [result, setResult] = useState<InlineEditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chapterBusy, setChapterBusy] = useState(false);
  const [chapterMsg, setChapterMsg] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The instruction of the most recent run — lets "本次执行" on a refusal
  // re-run the same ask with the guard lifted for that one call.
  const lastInstructionRef = useRef('');

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
    setSelectedIndex(0);
    setPhase('input');
    setResult(null);
    setError(null);
    setChapterBusy(false);
    setChapterMsg(null);
    setPos(null);
  }

  // The unified, grouped action list — depends only on the invocation mode.
  const actions = useMemo<Action[]>(() => {
    if (!ctx) return [];
    const list: Action[] = [];
    if (ctx.mode === 'selection') {
      list.push({ key: 'inline', kind: 'inline', label: '局部文本修改', group: '对选中的文本触发' });
      for (const cap of menuCaps) {
        const off = !taskConfigs[cap.id as keyof typeof taskConfigs]?.enabled;
        list.push({
          key: cap.id,
          kind: 'cap',
          capId: cap.id,
          label: taskLabel(cap.id),
          note: off ? '已关闭 · 单次运行' : undefined,
          group: '对选中的文本触发',
        });
      }
    } else {
      list.push({ key: 'inline', kind: 'inline', label: '局部修改', group: '在光标处触发' });
    }
    list.push({ key: 'chapter', kind: 'chapter', label: '生成章节摘要', group: '本章节触发' });
    return list;
  }, [ctx, menuCaps, taskConfigs, taskLabel]);

  const selIndex = Math.min(selectedIndex, Math.max(0, actions.length - 1));

  // Position: anchor below the caret, but if that would overflow the bottom,
  // slide up so the panel's bottom sticks to just above the app edge. Measured
  // after layout so the real height is used (the menu's height varies by mode/
  // phase). useLayoutEffect runs before paint → no flash.
  useLayoutEffect(() => {
    if (!visible || !ctx) return;
    const el = panelRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth || PANEL_WIDTH;
    let left = Math.min(ctx.clientX, window.innerWidth - w - VIEWPORT_MARGIN);
    left = Math.max(VIEWPORT_MARGIN, left);
    let top = ctx.clientY + 8;
    if (top + h > window.innerHeight - VIEWPORT_MARGIN) {
      top = window.innerHeight - VIEWPORT_MARGIN - h;
    }
    top = Math.max(VIEWPORT_MARGIN, top);
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [visible, ctx, phase, chapterMsg, result, error, actions.length]);

  // Focus the input when the popover opens / returns to input.
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
    async (instr: string, opts?: { forceAllowNewContent?: boolean }) => {
      if (!ctx || !instr.trim()) return;
      lastInstructionRef.current = instr.trim();
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
            segmentSummaries: ctx.segmentSummaries.length ? ctx.segmentSummaries : undefined,
          },
          instruction: instr.trim(),
          // One-shot override (本次执行) lifts the new-content guard for this
          // single run without touching the persisted setting.
          allowNewContent: allowNewContent || opts?.forceAllowNewContent === true,
          projectId: ctx.projectId,
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
        // Selection mode → run scoped to the selected blocks (Task 6). Block
        // mode → omit, so it runs on the rolling context (Task 7).
        selectionBlockIds: ctx.mode === 'selection' ? ctx.selectionBlockIds : undefined,
      });
      close();
    },
    [ctx, instruction, close],
  );

  // 本章节触发: reverse chapter summary (Task 5, fill-empty only).
  const handleChapterSummary = useCallback(async () => {
    if (!ctx) return;
    setChapterBusy(true);
    setChapterMsg(null);
    try {
      const r = await generateChapterSummary({ projectId: ctx.projectId, chapterId: ctx.nodeId });
      setChapterMsg(
        r.status === 'written'
          ? '已生成章节摘要'
          : r.status === 'skipped-nonempty'
            ? '本章已有摘要，未覆盖'
            : r.status === 'no-sections'
              ? '暂无段落摘要可汇总'
              : '生成失败',
      );
    } catch {
      setChapterMsg('生成失败');
    } finally {
      setChapterBusy(false);
    }
  }, [ctx]);

  const triggerAction = useCallback(
    (a: Action | undefined) => {
      if (!a) return;
      if (a.kind === 'inline') void runEdit(instruction.trim());
      else if (a.kind === 'cap' && a.capId) runCapability(a.capId);
      else if (a.kind === 'chapter') void handleChapterSummary();
    },
    [runEdit, runCapability, handleChapterSummary, instruction],
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

  // Group the flat action list into ordered (group → items) buckets, keeping
  // each item's flat index for keyboard-nav highlighting.
  const groups: { name: string; items: { action: Action; index: number }[] }[] = [];
  actions.forEach((action, index) => {
    let g = groups.find((x) => x.name === action.group);
    if (!g) {
      g = { name: action.group, items: [] };
      groups.push(g);
    }
    g.items.push({ action, index });
  });

  return (
    <>
      <div onMouseDown={doClose} style={{ position: 'fixed', inset: 0, zIndex: 998 }} />
      <div
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: pos ? pos.left : Math.max(VIEWPORT_MARGIN, ctx.clientX),
          top: pos ? pos.top : ctx.clientY + 8,
          visibility: pos ? 'visible' : 'hidden',
          zIndex: 999,
          width: PANEL_WIDTH,
          maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
          overflowY: 'auto',
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
                // Don't act while an IME composition is active — keys are
                // committing pinyin candidates, not navigating/sending.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelectedIndex((i) => Math.min(i + 1, actions.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelectedIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  triggerAction(actions[selIndex]);
                }
              }}
              placeholder="输入修改要求…"
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

            <div style={{ fontSize: 11, color: '#9a8a72', margin: '7px 2px 2px' }}>
              ↑/↓ 选择 · ⏎ 执行
            </div>

            {groups.map((group) => (
              <div
                key={group.name}
                style={{ borderTop: '1px solid rgba(184, 153, 104, 0.25)', marginTop: 8, paddingTop: 7 }}
              >
                <div style={{ fontSize: 11, color: '#9a8a72', marginBottom: 3 }}>{group.name}</div>
                {group.items.map(({ action, index }) => {
                  const isChapterBusy = action.kind === 'chapter' && chapterBusy;
                  return (
                    <button
                      key={action.key}
                      type="button"
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => triggerAction(action)}
                      disabled={isChapterBusy}
                      style={{
                        ...menuItemStyle,
                        background: index === selIndex ? 'rgba(184, 153, 104, 0.16)' : 'transparent',
                        opacity: isChapterBusy ? 0.6 : 1,
                      }}
                    >
                      <span>{action.label}</span>
                      {action.note && (
                        <span style={{ fontSize: 10, color: '#b0a088' }}>
                          {isChapterBusy ? '生成中…' : action.note}
                        </span>
                      )}
                    </button>
                  );
                })}
                {group.name === '本章节触发' && chapterMsg && (
                  <div style={{ fontSize: 11, color: '#8a7860', padding: '2px 4px' }}>{chapterMsg}</div>
                )}
              </div>
            ))}
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
              <button
                type="button"
                onClick={() => void runEdit(lastInstructionRef.current, { forceAllowNewContent: true })}
                style={primaryBtn}
                title="仅本次允许生成新内容（缺少全局上下文，质量可能下降）"
              >
                本次执行
              </button>
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
  padding: '5px 10px',
  borderRadius: 6,
  background: 'transparent',
  color: '#5a4a3a',
  fontSize: 12,
  cursor: 'pointer',
};

const menuItemStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
  border: 'none',
  borderRadius: 5,
  padding: '5px 6px',
  fontSize: 13,
  color: '#3a2e22',
  cursor: 'pointer',
  textAlign: 'left',
};
