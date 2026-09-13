import { describe, expect, it, vi } from 'vitest';
import type { AgentConversationUsage } from '../../sqlite-repo/agent-conversation-repo';
import { createAgentUsageHistoryController } from './agent-usage-history';
const rows: AgentConversationUsage[] = [{ id: 'c', title: 'Synthetic', updatedAt: '2026-09-13', deletedAt: null, inputTokens: 10, outputTokens: 2, costUsd: 0.1, turns: 1 }];
const receipt = [{ id: 'c', projectId: 'p', deletedAt: '2026-09-13' }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function fixture() {
  let project = 'p';
  const ports = { currentProjectId: () => project, list: vi.fn(async (): Promise<AgentConversationUsage[]> => rows), publish: vi.fn(),
    remove: vi.fn(async (): Promise<typeof receipt | null> => receipt), clear: vi.fn(async (_projectId: string) => receipt), requestConfirmation: vi.fn(async () => true) };
  return { ports, owner: createAgentUsageHistoryController(ports), project: (id: string) => { project = id; } };
}

describe('settings usage history mutation ownership', () => {
  it('does not mark spend rows deleted optimistically or on failure', async () => {
    const { ports, owner } = fixture(); owner.bind({ projectId: 'p', open: true }); await settle();
    const pending = deferred<typeof receipt | null>(); ports.remove.mockImplementationOnce(() => pending.promise);
    const deleting = owner.remove('c'); expect(ports.publish).toHaveBeenCalledTimes(1);
    pending.resolve(null); await deleting; expect(ports.list).toHaveBeenCalledTimes(1); expect(ports.publish).toHaveBeenLastCalledWith(rows);
  });
  it('reloads committed usage without losing historical spend and ignores an older query', async () => {
    const { ports, owner } = fixture(); const old = deferred<AgentConversationUsage[]>(); ports.list.mockImplementationOnce(() => old.promise);
    owner.bind({ projectId: 'p', open: true });
    const deleted = [{ ...rows[0]!, deletedAt: receipt[0]!.deletedAt }]; ports.list.mockResolvedValueOnce(deleted);
    await owner.remove('c'); await settle(); expect(ports.publish).toHaveBeenLastCalledWith(deleted);
    old.resolve(rows); await settle(); expect(ports.publish).toHaveBeenCalledTimes(1);
  });
  it('cancels a confirmation after project change and after an A to B to A rebinding', async () => {
    const { ports, owner, project } = fixture(); const pending = deferred<boolean>(); ports.requestConfirmation.mockImplementationOnce(() => pending.promise);
    owner.bind({ projectId: 'p', open: true }); const clearing = owner.clear(1);
    project('other'); owner.bind({ projectId: 'other', open: true }); project('p'); owner.bind({ projectId: 'p', open: true });
    pending.resolve(true); await clearing; expect(ports.clear).not.toHaveBeenCalled();
  });
  it('passes the viewed project explicitly and does not reload a new view after old deletion completes', async () => {
    const { ports, owner, project } = fixture(); const pending = deferred<typeof receipt>(); ports.clear.mockImplementationOnce(() => pending.promise);
    owner.bind({ projectId: 'p', open: true }); const clearing = owner.clear(1); await settle(); expect(ports.clear).toHaveBeenCalledWith('p');
    project('other'); owner.bind({ projectId: 'other', open: true }); await settle(); const calls = ports.list.mock.calls.length;
    pending.resolve(receipt); await clearing; expect(ports.list).toHaveBeenCalledTimes(calls);
  });
  it('does not execute or publish pending work after closing or disposal', async () => {
    const { ports, owner } = fixture(); const confirmation = deferred<boolean>(); ports.requestConfirmation.mockImplementationOnce(() => confirmation.promise);
    const pending = deferred<AgentConversationUsage[]>(); ports.list.mockImplementationOnce(() => pending.promise);
    owner.bind({ projectId: 'p', open: true }); const clearing = owner.clear(1); owner.unbind(); owner.dispose();
    confirmation.resolve(true); pending.resolve(rows); await clearing; await settle(); owner.bind({ projectId: 'p', open: true });
    expect(ports.clear).not.toHaveBeenCalled(); expect(ports.publish).not.toHaveBeenCalled(); expect(ports.list).toHaveBeenCalledTimes(1);
  });
});
