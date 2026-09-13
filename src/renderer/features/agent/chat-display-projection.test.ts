import { AgentChatTranscript } from '../../domain/agent-chat-transcript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { useAgentChatStore } from '../../store/agent-chat-store';
import { createAgentChatJournalScope } from '../../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../../lib/agent/runtime/long-task-auto-continuation';
import { markAgentChatMessagePublication } from '../../lib/agent/runtime/chat-message-publication';
import { createAgentChatDisplayProjection } from './chat-display-projection';

type State = ReturnType<typeof useAgentChatStore.getState>;
type Run = State['runs'][string];
function setup() {
  vi.useFakeTimers();
  const run = (): Run => ({ projectId: 'project', runtimeSessionId: 'session', journalScope: createAgentChatJournalScope(),
    transcript: AgentChatTranscript.from([]), controlStatus: null, pendingControl: null, lastTerminal: null, longTaskPlanState: null,
    contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation() });
  const source = createStore<State>(() => ({ ...useAgentChatStore.getState(), boundProjectId: 'project', activeConvId: 'first', runs: { first: run(), second: run() } }));
  const frames = new Map<number, () => void>();
  const visibility = new Set<() => void>();
  const timerCallbacks: (() => void)[] = [];
  let hidden = false;
  let nextFrame = 0;
  const projection = createAgentChatDisplayProjection(source, {
    requestFrame: (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelFrame: (id) => { frames.delete(id); },
    setTimer: (callback, ms) => { timerCallbacks.push(callback); return setTimeout(callback, ms); }, clearTimer: id => clearTimeout(id),
    isHidden: () => hidden,
    subscribeVisibility: (callback) => { visibility.add(callback); return () => { visibility.delete(callback); }; },
  });
  function publish(text: string, id = 'first', urgent = false) {
    const current = source.getState().runs[id];
    const messages: ReturnType<Run['transcript']['toArray']> = [{ kind: 'assistant', text, streaming: !urgent }];
    const transcript = AgentChatTranscript.from(messages);
    markAgentChatMessagePublication(transcript, urgent ? 'model_iteration_completed' : 'text_delta');
    source.setState({ runs: { ...source.getState().runs, [id]: { ...current, transcript } } });
    return transcript.toArray();
  }
  function changeRun(change: Partial<Run>) {
    const state = source.getState();
    source.setState({ runs: { ...state.runs, first: { ...state.runs.first, ...change } } });
  }
  return { source, projection, frames, visibility, timerCallbacks, publish, changeRun,
    nextFrame: () => { for (const callback of [...frames.values()]) callback(); },
    hide: () => { hidden = true; for (const callback of visibility) callback(); },
    show: () => { hidden = false; for (const callback of visibility) callback(); },
  };
}
afterEach(() => { vi.useRealTimers(); });

describe('Agent chat display notification projection', () => {
  it('coalesces a burst for shared consumers while canonical snapshots remain current', () => {
    const f = setup();
    const first = vi.fn(); const second = vi.fn();
    const releaseFirst = f.projection.subscribe(first); const releaseSecond = f.projection.subscribe(second);
    const old = f.projection.getSnapshot();
    for (let index = 1; index <= 100; index++) f.publish('字'.repeat(index));
    expect(f.source.getState().runs.first.transcript.toArray()).toMatchObject([{ text: '字'.repeat(100) }]);
    expect(f.projection.getSnapshot()).toBe(old);
    expect(f.frames.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
    f.nextFrame();
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
    expect(f.projection.getSnapshot()).toBe(f.source.getState().runs.first.transcript.toArray());
    expect(old).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    releaseFirst(); releaseSecond();
  });

  it('bounds hidden bursts with one timer and flushes both visibility transitions', () => {
    const f = setup(); const listener = vi.fn(); const release = f.projection.subscribe(listener);
    f.publish('首段');
    vi.advanceTimersByTime(49); expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(listener).toHaveBeenCalledTimes(1); expect(f.frames.size).toBe(0);
    f.publish('隐藏前的尾部'); f.hide();
    expect(f.projection.getSnapshot()).toMatchObject([{ text: '隐藏前的尾部' }]);
    for (let index = 1; index <= 100; index++) f.publish(`后台尾部 ${index}`);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(f.frames.size).toBe(0); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(49); expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1); expect(listener).toHaveBeenCalledTimes(3);
    expect(f.projection.getSnapshot()).toMatchObject([{ text: '后台尾部 100' }]);
    f.publish('返回前台的尾部'); f.show();
    expect(f.projection.getSnapshot()).toMatchObject([{ text: '返回前台的尾部' }]);
    expect(f.frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    release();
  });

  it.each(['permission', 'cancellation', 'terminal', 'author'] as const)('flushes hidden text synchronously on %s', boundary => {
    const f = setup(); const listener = vi.fn(); const release = f.projection.subscribe(listener); f.hide();
    f.publish('边界前的隐藏文本'); expect(listener).not.toHaveBeenCalled();
    if (boundary === 'permission') f.changeRun({ controlStatus: 'waiting_permission' });
    else if (boundary === 'cancellation') f.changeRun({ controlStatus: 'cancelling' });
    else if (boundary === 'terminal') f.changeRun({ controlStatus: null, lastTerminal: { turnId: 'turn', outcome: 'completed' } });
    else f.source.setState({ starting: true });
    expect(f.projection.getSnapshot()).toMatchObject([{ text: '边界前的隐藏文本' }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100); expect(listener).toHaveBeenCalledTimes(1); release();
  });

  it.each(['frame', 'timer', 'visibility'] as const)('ignores an old %s callback after remount', kind => {
    const f = setup(); const release = f.projection.subscribe(() => undefined); f.publish('旧订阅');
    const stale = kind === 'frame' ? [...f.frames.values()][0] : kind === 'timer' ? f.timerCallbacks[0] : [...f.visibility][0];
    release();
    const listener = vi.fn(); const releaseAgain = f.projection.subscribe(listener); f.publish('新订阅等待刷新');
    stale();
    expect(listener).not.toHaveBeenCalled(); expect(f.frames.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
    f.nextFrame(); expect(f.projection.getSnapshot()).toMatchObject([{ text: '新订阅等待刷新' }]);
    expect(listener).toHaveBeenCalledTimes(1); releaseAgain();
  });

  it('flushes pending text on permission, cancellation, terminal and author changes', () => {
    const f = setup(); const release = f.projection.subscribe(() => undefined);
    f.publish('权限之前'); f.changeRun({ controlStatus: 'waiting_permission' });
    expect(f.projection.getSnapshot()).toMatchObject([{ text: '权限之前' }]);
    f.publish('取消之前'); f.changeRun({ controlStatus: 'cancelling' });
    expect(f.projection.getSnapshot()).toMatchObject([{ text: '取消之前' }]);
    const terminal = f.publish('最终内容', 'first', true);
    expect(f.projection.getSnapshot()).toBe(terminal);
    f.publish('发送之前');
    f.source.setState({ starting: true });
    expect(f.projection.getSnapshot()).toMatchObject([{ text: '发送之前' }]);
    expect(vi.getTimerCount()).toBe(0);
    release();
  });

  it('switches conversations atomically without losing an outgoing tail', () => {
    const f = setup(); const release = f.projection.subscribe(() => undefined);
    const pendingFirst = f.publish('会话一尾部');
    const second = f.publish('会话二', 'second');
    f.source.setState({ activeConvId: 'second' });
    expect(f.projection.getSnapshot()).toBe(second);
    expect(f.frames.size).toBe(0);
    f.source.setState({ activeConvId: 'first' });
    expect(f.projection.getSnapshot()).toBe(pendingFirst);
    f.source.setState({ activeConvId: null, boundProjectId: 'another-project' });
    expect(f.projection.getSnapshot()).toEqual([]);
    release();
  });

  it('does not flush or notify for sibling run updates', () => {
    const f = setup(); const listener = vi.fn(); const release = f.projection.subscribe(listener);
    f.publish('未到帧的内容');
    for (let index = 0; index < 100; index++) f.publish(String(index), 'second');
    expect(listener).not.toHaveBeenCalled();
    expect(f.projection.getSnapshot()).toEqual([]);
    f.nextFrame(); expect(listener).toHaveBeenCalledTimes(1);
    release();
  });

  it('disposes timers/listeners and remounts from the latest canonical array', () => {
    const f = setup(); const listener = vi.fn(); const release = f.projection.subscribe(listener);
    f.publish('卸载之前'); release(); release();
    expect(f.frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0); expect(f.visibility.size).toBe(0);
    const latest = f.publish('卸载后继续接收');
    expect(listener).not.toHaveBeenCalled();
    expect(f.projection.getSnapshot()).toBe(latest);
    const releaseAgain = f.projection.subscribe(listener);
    expect(f.projection.getSnapshot()).toBe(latest);
    releaseAgain();
  });
});
