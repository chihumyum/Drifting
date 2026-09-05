import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobilePaperAgentSession, paperAgentKey, readPaperAgentEntry, writePaperAgentEntry, type PaperAgentChatPort } from './mobile-paper-agent-session';

function chatPort() {
  const listeners = new Set<() => void>();
  const state = {
    boundProjectId: null as string | null, activeConvId: null as string | null, prompt: '',
    bindProject: vi.fn((id: string) => { state.boundProjectId = id; }),
    newConversation: vi.fn(() => { state.activeConvId = null; state.prompt = ''; notify(); }),
    loadConversation: vi.fn(async (id: string) => { state.activeConvId = id; notify(); }),
    setPrompt: (prompt: string) => { state.prompt = prompt; notify(); },
  };
  const notify = () => listeners.forEach((listener) => listener());
  const port: PaperAgentChatPort = { getState: () => state, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  return { port, state, acceptSend(id: string) { state.activeConvId = id; state.prompt = ''; notify(); } };
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
});
describe('paper Agent presentation ownership', () => {
  it('starts blank without creating a session, remembers first send, and restores it', async () => {
    const { port, state, acceptSend } = chatPort();
    const session = new MobilePaperAgentSession('project-a', 'paper-a', port, async () => true);
    await session.open();
    expect(state.bindProject).toHaveBeenCalledWith('project-a', { restoreLastConversation: false });
    expect(state.activeConvId).toBeNull();
    expect(state.loadConversation).not.toHaveBeenCalled();
    state.setPrompt('User text only'); acceptSend('session-a'); session.dispose();
    expect(readPaperAgentEntry(paperAgentKey('project-a', 'paper-a')).conversationId).toBe('session-a');
    const reopen = new MobilePaperAgentSession('project-a', 'paper-a', port, async () => true);
    await reopen.open(); expect(state.activeConvId).toBe('session-a'); expect(state.prompt).toBe(''); reopen.dispose();
  });
  it('keeps drafts separate across papers and existing conversations', async () => {
    const { port, state } = chatPort();
    const first = new MobilePaperAgentSession('project-b', 'paper-b1', port, async () => true);
    await first.open(); state.setPrompt('New draft'); await first.select('session-b'); state.setPrompt('Session draft');
    await first.select(null); expect(state.prompt).toBe('New draft'); await first.select('session-b'); expect(state.prompt).toBe('Session draft'); first.dispose();
    const second = new MobilePaperAgentSession('project-b', 'paper-b2', port, async () => true);
    await second.open(); expect(state.activeConvId).toBeNull(); expect(state.prompt).toBe(''); await second.select('session-b'); expect(state.prompt).toBe(''); second.dispose();
  });
  it('forgets a deleted or foreign conversation pointer and handles storage corruption', async () => {
    const { port, state } = chatPort();
    const key = paperAgentKey('project-c', 'paper-c'); writePaperAgentEntry(key, 'deleted');
    const session = new MobilePaperAgentSession('project-c', 'paper-c', port, async () => false);
    await session.open(); expect(state.loadConversation).not.toHaveBeenCalled(); expect(readPaperAgentEntry(key).conversationId).toBeNull(); session.dispose();
    localStorage.setItem('drifting.mobile.paper-agent.v1', 'null'); expect(readPaperAgentEntry(key).conversationId).toBeNull();
  });
  it('ignores delayed selection lookup after a newer selection or leaving the entry', async () => {
    const { port, state } = chatPort();
    let resolve!: (exists: boolean) => void;
    const session = new MobilePaperAgentSession('project-d', 'paper-d', port, () => new Promise((done) => { resolve = done; }));
    await session.open(); const pending = session.select('slow'); await session.select(null); state.setPrompt('Keep latest draft'); resolve(true); await pending;
    expect(state.activeConvId).toBeNull(); expect(state.prompt).toBe('Keep latest draft'); expect(state.loadConversation).not.toHaveBeenCalled();
    const leaving = session.select('slow-again'); session.dispose(); resolve(true); await leaving; expect(state.loadConversation).not.toHaveBeenCalled();
  });
  it('leaves a running conversation selected on close without a runtime cancellation API', async () => {
    const { port, state, acceptSend } = chatPort(); const session = new MobilePaperAgentSession('project-e', 'paper-e', port, async () => true);
    await session.open(); acceptSend('running'); state.newConversation.mockClear(); session.dispose();
    expect(state.activeConvId).toBe('running'); expect(state.newConversation).not.toHaveBeenCalled();
  });
});


it('keeps text entered while an existing session is loading', async () => {
  const { port, state } = chatPort();
  let resolve!: (exists: boolean) => void;
  const session = new MobilePaperAgentSession('project-f', 'paper-f', port, () => new Promise((done) => { resolve = done; }));
  await session.open();
  const pending = session.select('session-f');
  session.getSnapshot().setPrompt('Keep typing during hydration');
  resolve(true); await pending;
  expect(state.activeConvId).toBe('session-f');
  expect(state.prompt).toBe('Keep typing during hydration');
  session.dispose();
});


it('reopens the current running session without resetting its owner or startup', async () => {
  const { port, state, acceptSend } = chatPort();
  const first = new MobilePaperAgentSession('project-g', 'paper-g', port, async () => true);
  await first.open(); acceptSend('running-g'); first.dispose();
  state.newConversation.mockClear(); state.loadConversation.mockClear();
  const reopen = new MobilePaperAgentSession('project-g', 'paper-g', port, async () => true);
  await reopen.open();
  expect(state.newConversation).not.toHaveBeenCalled();
  expect(state.loadConversation).not.toHaveBeenCalled();
  expect(state.activeConvId).toBe('running-g');
  reopen.dispose();
});


it('closing during a current-session existence check preserves its running owner', async () => {
  const { port, state, acceptSend } = chatPort();
  const first = new MobilePaperAgentSession('project-h', 'paper-h', port, async () => true);
  await first.open(); acceptSend('running-h'); first.dispose();
  let resolve!: (exists: boolean) => void;
  const reopen = new MobilePaperAgentSession('project-h', 'paper-h', port, () => new Promise((done) => { resolve = done; }));
  state.newConversation.mockClear();
  const pending = reopen.open(); reopen.dispose(); resolve(true); await pending;
  expect(state.newConversation).not.toHaveBeenCalled();
  expect(state.activeConvId).toBe('running-h');
});
