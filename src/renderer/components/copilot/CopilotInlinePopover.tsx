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
import { useTranslation } from 'react-i18next';
import { useCopilotInlineStore, type CopilotInlineCtx } from '../../store/copilot-inline-store';
import { useSettingsStore, COPILOT_TASKS } from '../../store/settings-store';
import { capabilitiesForTrigger } from '../../lib/copilot/capability';
import {
  runInlineEdit,
  applyInlineEdit,
  type InlineEditResult,
} from '../../lib/copilot/inline-edit';
import type { DiffChunk } from '../../lib/copilot/text-diff';
import { runInlineAskStream, type AskTurn } from '../../lib/copilot/inline-ask';
import { generateChapterSummary } from '../../lib/copilot/reverse-chapter-summary';
import { events } from '../../lib/events';
import '../../../styles/copilot-surface.css';

const PANEL_WIDTH = 360;
const VIEWPORT_MARGIN = 8;

type Phase = 'input' | 'running' | 'result' | 'refused' | 'error' | 'chat';

/** One row in the unified action menu. */
interface Action {
  key: string;
  kind: 'inline' | 'cap' | 'chapter' | 'ask';
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
  const { t } = useTranslation();
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
  // Chat (提问/讨论) — multi-turn, streamed, never persisted.
  const [chatTurns, setChatTurns] = useState<AskTurn[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatInput, setChatInput] = useState('');
  // Mirrors chatTurns synchronously so the async stream loop reads the latest
  // history without waiting for a re-render.
  const turnsRef = useRef<AskTurn[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The instruction of the most recent run — lets "本次执行" on a refusal
  // re-run the same ask with the guard lifted for that one call.
  const lastInstructionRef = useRef('');

  const menuCaps = useMemo(() => capabilitiesForTrigger('editor-block-debounced'), []);
  const taskLabel = useCallback(
    (id: string) =>
      t(`copilotInline.tasks.${id}`, {
        defaultValue: COPILOT_TASKS.find((task) => task.id === id)?.label ?? id,
      }),
    [t],
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
    setChatTurns([]);
    setStreamingText('');
    setChatBusy(false);
    setChatInput('');
  }

  // The unified, grouped action list — depends only on the invocation mode.
  const actions = useMemo<Action[]>(() => {
    if (!ctx) return [];
    const list: Action[] = [];
    if (ctx.mode === 'selection') {
      list.push({
        key: 'inline',
        kind: 'inline',
        label: t('copilotInline.actions.inlineSelection'),
        group: t('copilotInline.groups.selection'),
      });
      list.push({
        key: 'ask',
        kind: 'ask',
        label: t('copilotInline.actions.ask'),
        group: t('copilotInline.groups.selection'),
      });
      for (const cap of menuCaps) {
        const off = !taskConfigs[cap.id as keyof typeof taskConfigs]?.enabled;
        list.push({
          key: cap.id,
          kind: 'cap',
          capId: cap.id,
          label: taskLabel(cap.id),
          note: off ? t('copilotInline.status.offOneShot') : undefined,
          group: t('copilotInline.groups.selection'),
        });
      }
    } else {
      list.push({
        key: 'inline',
        kind: 'inline',
        label: t('copilotInline.actions.inlineCursor'),
        group: t('copilotInline.groups.cursor'),
      });
      list.push({
        key: 'ask',
        kind: 'ask',
        label: t('copilotInline.actions.ask'),
        group: t('copilotInline.groups.cursor'),
      });
    }
    list.push({
      key: 'chapter',
      kind: 'chapter',
      label: t('copilotInline.actions.chapterSummary'),
      group: t('copilotInline.groups.chapter'),
    });
    return list;
  }, [ctx, menuCaps, taskConfigs, taskLabel, t]);

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

  // Focus the input when the popover opens / returns to input; focus the chat
  // follow-up box once an answer finishes streaming.
  useEffect(() => {
    if (!visible) return;
    if (phase === 'input') {
      const id = setTimeout(() => textareaRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
    if (phase === 'chat' && !chatBusy) {
      const id = setTimeout(() => chatInputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [visible, ctx, phase, chatBusy]);

  // Abort any in-flight call when the popover unmounts OR the invocation
  // changes (so a stream from a prior selection can't bleed into a new one).
  useEffect(() => () => abortRef.current?.abort(), [ctx]);

  // Reset the chat-history mirror on each new invocation. Lives in an effect,
  // not the render-phase reset above, since refs can't be mutated in render.
  useEffect(() => {
    turnsRef.current = [];
  }, [ctx]);

  // Auto-follow the newest tokens as the answer streams — but only while the
  // user is parked at the bottom. The moment they scroll up to re-read, we stop
  // yanking them back down; scrolling back to the bottom re-arms the follow.
  const stickToBottomRef = useRef(true);
  const onChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 24;
  }, []);
  useEffect(() => {
    if (phase !== 'chat' || !stickToBottomRef.current) return;
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [phase, streamingText, chatTurns]);

  // Re-arm auto-follow when a new question is sent (the user wants to watch the
  // fresh answer), independent of where they'd scrolled in the prior answer.
  useEffect(() => {
    if (chatBusy) stickToBottomRef.current = true;
  }, [chatBusy]);

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
            spanWithinBlock: ctx.spanWithinBlock,
            from: ctx.from,
            to: ctx.to,
            selectedText: ctx.selectedText,
            blockContext: ctx.blockContext,
            targetBlocks: ctx.targetBlocks,
            contextBefore: ctx.contextBefore || undefined,
            contextAfter: ctx.contextAfter || undefined,
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

  // 提问/讨论: append the question and stream a free-form answer. Multi-turn,
  // read-only, ephemeral — nothing touches the document or gets persisted.
  const sendAsk = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!ctx || !q) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const history: AskTurn[] = [...turnsRef.current, { role: 'user', content: q }];
      turnsRef.current = history;
      setChatTurns(history);
      setChatInput('');
      setStreamingText('');
      setChatBusy(true);
      setError(null);
      setPhase('chat');
      try {
        let acc = '';
        for await (const delta of runInlineAskStream({
          history,
          context: {
            selectedText: ctx.selectedText,
            contextBefore: ctx.contextBefore || undefined,
            contextAfter: ctx.contextAfter || undefined,
            segmentSummaries: ctx.segmentSummaries.length ? ctx.segmentSummaries : undefined,
          },
          projectId: ctx.projectId,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) return;
          acc += delta;
          setStreamingText(acc);
        }
        if (controller.signal.aborted) return;
        const next: AskTurn[] = [...turnsRef.current, { role: 'model', content: acc }];
        turnsRef.current = next;
        setChatTurns(next);
        setStreamingText('');
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      } finally {
        setChatBusy(false);
      }
    },
    [ctx],
  );

  const acceptResult = useCallback(() => {
    if (!result) return;
    const ok = applyInlineEdit(editor, result);
    if (!ok) {
      setError(t('copilotInline.errors.selectionChanged'));
      setPhase('error');
      return;
    }
    close();
  }, [result, editor, close, t]);

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
          ? t('copilotInline.chapter.written')
          : r.status === 'skipped-nonempty'
            ? t('copilotInline.chapter.skippedNonempty')
            : r.status === 'no-sections'
              ? t('copilotInline.chapter.noSections')
              : t('copilotInline.chapter.failed'),
      );
    } catch {
      setChapterMsg(t('copilotInline.chapter.failed'));
    } finally {
      setChapterBusy(false);
    }
  }, [ctx, t]);

  const triggerAction = useCallback(
    (a: Action | undefined) => {
      if (!a) return;
      if (a.kind === 'inline') void runEdit(instruction.trim());
      else if (a.kind === 'ask') void sendAsk(instruction.trim());
      else if (a.kind === 'cap' && a.capId) runCapability(a.capId);
      else if (a.kind === 'chapter') void handleChapterSummary();
    },
    [runEdit, sendAsk, runCapability, handleChapterSummary, instruction],
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
          background: 'var(--copilot-surface)',
          border: '1px solid var(--copilot-border)',
          borderRadius: 'var(--copilot-radius)',
          boxShadow: '0 12px 32px var(--copilot-shadow)',
          padding: 12,
          fontSize: 13,
          color: 'var(--copilot-text)',
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
              placeholder={t('copilotInline.input.placeholder')}
              rows={2}
              className="copilot-field"
              style={{
                width: '100%',
                resize: 'none',
                border: '1px solid var(--copilot-border)',
                borderRadius: 'var(--copilot-radius-sm)',
                padding: '6px 8px',
                fontSize: 13,
                outline: 'none',
                background: 'var(--copilot-field-bg)',
                fontFamily: 'inherit',
              }}
            />

            <div style={{ fontSize: 11, color: 'var(--copilot-text-dim)', margin: '7px 2px 2px' }}>
              {t('copilotInline.input.hint')}
            </div>

            {groups.map((group) => (
              <div
                key={group.name}
                style={{ borderTop: '1px solid var(--copilot-border-soft)', marginTop: 8, paddingTop: 7 }}
              >
                <div style={{ fontSize: 11, color: 'var(--copilot-text-dim)', marginBottom: 3 }}>{group.name}</div>
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
                        background: index === selIndex ? 'var(--copilot-hover-bg)' : 'transparent',
                        opacity: isChapterBusy ? 0.6 : 1,
                      }}
                    >
                      <span>{action.label}</span>
                      {action.note && (
                        <span style={{ fontSize: 10, color: 'var(--copilot-text-faint)' }}>
                          {isChapterBusy ? t('copilotInline.status.generating') : action.note}
                        </span>
                      )}
                    </button>
                  );
                })}
                {group.name === t('copilotInline.groups.chapter') && chapterMsg && (
                  <div style={{ fontSize: 11, color: 'var(--copilot-text-dim)', padding: '2px 4px' }}>{chapterMsg}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {phase === 'running' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px' }}>
            <span style={spinnerStyle} />
            <span style={{ color: 'var(--copilot-text-dim)' }}>
              {t('copilotInline.status.editing')}
            </span>
            <button type="button" onClick={doClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
              {t('common.cancel')}
            </button>
          </div>
        )}

        {phase === 'chat' && (
          <div>
            <div
              ref={chatScrollRef}
              onScroll={onChatScroll}
              style={{
                maxHeight: 320,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                paddingRight: 2,
              }}
            >
              {chatTurns.map((turn, i) => (
                <div key={i} style={turn.role === 'user' ? askUserTurn : askModelTurn}>
                  <div style={askTurnLabel}>
                    {turn.role === 'user'
                      ? t('copilotInline.chat.you')
                      : t('copilotInline.chat.assistant')}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{turn.content}</div>
                </div>
              ))}
              {(chatBusy || streamingText) && (
                <div style={askModelTurn}>
                  <div style={askTurnLabel}>{t('copilotInline.chat.assistant')}</div>
                  <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                    {streamingText ? (
                      <>
                        {streamingText}
                        {chatBusy && <span style={caretStyle} />}
                      </>
                    ) : (
                      <span style={{ color: 'var(--copilot-text-dim)' }}>
                        {t('copilotInline.status.thinking')}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            <textarea
              ref={chatInputRef}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!chatBusy) void sendAsk(chatInput);
                }
              }}
              placeholder={
                chatBusy
                  ? t('copilotInline.chat.generatingPlaceholder')
                  : t('copilotInline.chat.followupPlaceholder')
              }
              rows={2}
              disabled={chatBusy}
              className="copilot-field"
              style={{
                width: '100%',
                resize: 'none',
                border: '1px solid var(--copilot-border)',
                borderRadius: 'var(--copilot-radius-sm)',
                padding: '6px 8px',
                marginTop: 10,
                fontSize: 13,
                outline: 'none',
                background: chatBusy ? 'var(--copilot-field-bg-off)' : 'var(--copilot-field-bg)',
                fontFamily: 'inherit',
              }}
            />

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {chatBusy ? (
                <button type="button" onClick={() => abortRef.current?.abort()} style={ghostBtn}>
                  {t('copilotInline.actions.stop')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void sendAsk(chatInput)}
                  style={{ ...primaryBtn, opacity: chatInput.trim() ? 1 : 0.5 }}
                  disabled={!chatInput.trim()}
                >
                  {t('copilotInline.actions.send')} <kbd style={kbdStyle}>↵</kbd>
                </button>
              )}
              <button type="button" onClick={doClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
                {t('copilotInline.actions.close')}
              </button>
            </div>
          </div>
        )}

        {phase === 'result' &&
          result &&
          (() => {
            const changedBlocks = result.blocks?.filter((b) => b.changed) ?? [];
            const changeCount = result.span ? 1 : changedBlocks.length;
            return (
              <div>
                {changeCount === 0 ? (
                  <div style={{ color: 'var(--copilot-text-dim)', padding: '4px 2px' }}>
                    {t('copilotInline.result.noChange')}
                  </div>
                ) : (
                  <>
                    <div style={{ ...previewLabel, marginBottom: 6 }}>
                      {result.span
                        ? t('copilotInline.result.preview')
                        : t('copilotInline.result.changeCount', { count: changeCount })}
                    </div>
                    <div
                      style={{
                        maxHeight: 280,
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      {result.span ? (
                        <div style={diffBox}>
                          <DiffText diff={result.span.diff} />
                        </div>
                      ) : (
                        changedBlocks.map((b) => (
                          <div key={b.id}>
                            <div style={diffCardLabel}>
                              {b.kind === 'heading'
                                ? t('copilotInline.result.heading')
                                : t('copilotInline.result.paragraph', {
                                    index: result.blocks!.indexOf(b) + 1,
                                  })}
                            </div>
                            <div style={diffBox}>
                              <DiffText diff={b.diff} />
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
                {result.reason && (
                  <div style={{ fontSize: 11, color: 'var(--copilot-text-dim)', marginTop: 8 }}>{result.reason}</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  {changeCount > 0 && (
                    <button type="button" onClick={acceptResult} style={primaryBtn}>
                      {t('copilotInline.actions.accept')} <kbd style={kbdStyle}>↵</kbd>
                    </button>
                  )}
                  <button type="button" onClick={() => setPhase('input')} style={ghostBtn}>
                    {t('copilotInline.actions.rewrite')}
                  </button>
                  <button type="button" onClick={doClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
                    {t('copilotInline.actions.discard')}
                  </button>
                </div>
              </div>
            );
          })()}

        {phase === 'refused' && result && (
          <div>
            <div style={{ color: 'var(--copilot-warn)', fontWeight: 600, marginBottom: 4 }}>
              {t('copilotInline.refused.title')}
            </div>
            <div style={{ color: 'var(--copilot-text-dim)' }}>{result.reason}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="button"
                onClick={() => void runEdit(lastInstructionRef.current, { forceAllowNewContent: true })}
                style={primaryBtn}
                title={t('copilotInline.refused.forceTitle')}
              >
                {t('copilotInline.refused.force')}
              </button>
              <button type="button" onClick={() => setPhase('input')} style={ghostBtn}>
                {t('copilotInline.refused.changeInstruction')}
              </button>
              <button type="button" onClick={doClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
                {t('copilotInline.actions.close')}
              </button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div>
            <div style={{ color: 'var(--copilot-warn)', fontWeight: 600, marginBottom: 4 }}>
              {t('copilotInline.error.title')}
            </div>
            <div style={{ color: 'var(--copilot-text-dim)', wordBreak: 'break-word' }}>{error}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" onClick={() => setPhase('input')} style={ghostBtn}>
                {t('copilotInline.error.retry')}
              </button>
              <button type="button" onClick={doClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
                {t('copilotInline.actions.close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** Renders a char-level diff inline: deletions struck red, insertions green. */
function DiffText({ diff }: { diff: DiffChunk[] }) {
  return (
    <>
      {diff.map((c, i) =>
        c.type === 'equal' ? (
          <span key={i}>{c.text}</span>
        ) : (
          <span key={i} style={c.type === 'delete' ? diffDel : diffIns}>
            {c.text}
          </span>
        ),
      )}
    </>
  );
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 11,
  background: 'var(--copilot-kbd-bg)',
  borderRadius: 4,
  padding: '0 4px',
};

const spinnerStyle: React.CSSProperties = {
  width: 13,
  height: 13,
  border: '2px solid var(--copilot-border)',
  borderTopColor: 'var(--copilot-accent)',
  borderRadius: '50%',
  display: 'inline-block',
  animation: 'copilot-inline-spin 0.7s linear infinite',
};

const previewLabel: React.CSSProperties = { fontSize: 11, color: 'var(--copilot-text-dim)' };
const diffCardLabel: React.CSSProperties = { fontSize: 10, color: 'var(--copilot-text-dim)', marginBottom: 2 };
const diffBox: React.CSSProperties = {
  border: '1px solid var(--copilot-border-soft)',
  borderRadius: 'var(--copilot-radius-sm)',
  padding: '6px 8px',
  fontSize: 13,
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--copilot-text)',
  background: 'var(--copilot-field-bg)',
};
const diffDel: React.CSSProperties = {
  color: 'var(--copilot-diff-del-fg)',
  background: 'var(--copilot-diff-del-bg)',
  textDecoration: 'line-through',
};
const diffIns: React.CSSProperties = {
  color: 'var(--copilot-diff-ins-fg)',
  background: 'var(--copilot-diff-ins-bg)',
};

const askTurnLabel: React.CSSProperties = { fontSize: 10, color: 'var(--copilot-text-dim)', marginBottom: 2 };
const askUserTurn: React.CSSProperties = {
  border: '1px solid var(--copilot-border-soft)',
  borderRadius: 'var(--copilot-radius-sm)',
  padding: '6px 8px',
  background: 'var(--copilot-bubble-bg)',
  fontSize: 13,
  color: 'var(--copilot-text)',
};
const askModelTurn: React.CSSProperties = {
  border: '1px solid var(--copilot-border-soft)',
  borderRadius: 'var(--copilot-radius-sm)',
  padding: '6px 8px',
  background: 'var(--copilot-field-bg)',
  fontSize: 13,
  color: 'var(--copilot-text)',
};
const caretStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 2,
  height: '1em',
  marginLeft: 2,
  verticalAlign: 'text-bottom',
  background: 'var(--copilot-accent)',
  borderRadius: 1,
};

const primaryBtn: React.CSSProperties = {
  border: 'none',
  borderRadius: 'var(--copilot-radius-sm)',
  background: 'var(--copilot-accent)',
  color: 'var(--copilot-accent-text)',
  padding: '5px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

const ghostBtn: React.CSSProperties = {
  border: '1px solid var(--copilot-border)',
  padding: '5px 10px',
  borderRadius: 'var(--copilot-radius-sm)',
  background: 'transparent',
  color: 'var(--copilot-text)',
  fontSize: 12,
  cursor: 'pointer',
};

const menuItemStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
  border: 'none',
  borderRadius: 'var(--copilot-radius-sm)',
  padding: '5px 6px',
  fontSize: 13,
  color: 'var(--copilot-text)',
  cursor: 'pointer',
  textAlign: 'left',
  background: 'transparent',
};
