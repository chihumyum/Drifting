import { describe, expect, it, vi } from 'vitest';
import type { AgentConversationSummary } from '../../../domain/agent-conversation';
import { createAgentConversationListController } from './chat-conversation-navigation';
const rows: AgentConversationSummary[] = [{ id: 'synthetic-saved', title: 'Synthetic', mode: 'byok', updatedAt: '2026-09-13' }];
const initial = () => ({ projectId: 'synthetic-project', activeConvId: null, prompt: '', starting: false });
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

describe('conversation list controller lifetime', () => {
  it('disposes pending reads and refuses later requests', async () => {
    let resolve!: (rows: AgentConversationSummary[]) => void;
    const list = vi.fn(() => new Promise<AgentConversationSummary[]>(done => { resolve = done; }));
    const publish = vi.fn(); const restore = vi.fn(async () => undefined);
    const controller = createAgentConversationListController({ read: initial, list, publish, restore, lastConversation: () => 'synthetic-saved' });
    controller.bind('synthetic-project', true); controller.refresh(); controller.dispose();
    resolve(rows); await settle(); controller.bind('synthetic-project', true); controller.refresh();
    expect(list).toHaveBeenCalledTimes(1); expect(publish).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
  });

  it('lets author intent during list publication cancel restoration', async () => {
    const restore = vi.fn(async () => undefined);
    const controller = createAgentConversationListController({ read: initial, list: async () => rows,
      publish: () => controller.cancelRestore(), restore, lastConversation: () => 'synthetic-saved' });
    controller.bind('synthetic-project', true); controller.refresh(); await settle(); expect(restore).not.toHaveBeenCalled();
  });

  it('keeps one restoration through ordinary list refreshes and invalidates it on author intent', async () => {
    let current!: () => boolean; let finish!: () => void;
    const restore = vi.fn(async (_id: string, guard: () => boolean) => { current = guard; await new Promise<void>(done => { finish = done; }); });
    const controller = createAgentConversationListController({ read: initial, list: async () => rows, publish: () => undefined,
      restore, lastConversation: () => 'synthetic-saved' });
    controller.bind('synthetic-project', true); controller.refresh(); await settle();
    controller.refresh(); await settle(); expect(restore).toHaveBeenCalledTimes(1); expect(current()).toBe(true);
    controller.cancelRestore(); expect(current()).toBe(false); finish(); await settle();
  });
});
