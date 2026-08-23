import { describe, expect, it, vi } from 'vitest';
import type { AgentChatMessage } from '../../../domain/agent-conversation';
import { useDataStore } from '../../../store/data-store';
import {
  buildMobileAgentTurnContext,
  collectMobileAgentEvidence,
  mobileAgentOutputProseJson,
  mobileAgentOutputTitle,
  mobileAgentTodoAnchor,
  openMobileAgentEvidence,
} from './mobile-agent-model';

describe('mobile agent model', () => {
  it('builds explicit project, entity, and stable-block context', () => {
    const refs = buildMobileAgentTurnContext({
      projectId: 'p1',
      projectName: 'My Book',
      target: { entityType: 'node', id: 'node-1' },
      targetLabel: 'Chapter One',
      blockId: 'block-1',
    });
    expect(refs).toEqual([
      { kind: 'project', projectId: 'p1', label: 'My Book' },
      {
        kind: 'workspace',
        projectId: 'p1',
        label: 'Chapter One',
        entityType: 'node',
        entityId: 'node-1',
        blockId: 'block-1',
      },
    ]);
    expect(mobileAgentTodoAnchor(refs)).toEqual({
      targetKind: 'node',
      targetId: 'node-1',
      targetBlockId: 'block-1',
    });
  });

  it('round-trips tool evidence to the exact entity and stable block jump', () => {
    useDataStore.setState({
      bookNodes: [
        {
          id: 'node-1',
          projectId: 'p1',
          title: 'Chapter One',
          kind: 'chapter',
        } as never,
      ],
    });
    const messages: AgentChatMessage[] = [
      {
        kind: 'tool',
        id: 'tool-1',
        name: 'read_block',
        input: { node: 'Chapter One', blockId: 'block-1' },
        status: 'ok',
        result: JSON.stringify({ found: true, blockId: 'block-1', text: 'Evidence' }),
      },
    ];
    const evidence = collectMobileAgentEvidence(messages);
    expect(evidence).toEqual([
      { entityType: 'node', entityId: 'node-1', blockId: 'block-1', operation: 'read' },
    ]);
    const open = vi.fn();
    const scrollToBlock = vi.fn();
    openMobileAgentEvidence(evidence[0]!, { open, scrollToBlock });
    expect(open).toHaveBeenCalledWith({ entityType: 'node', id: 'node-1' });
    expect(scrollToBlock).toHaveBeenCalledWith('node-1', 'block-1');
  });

  it('prepares output only for an explicit inspiration action', () => {
    let id = 0;
    const prose = mobileAgentOutputProseJson('First paragraph\n\nSecond paragraph', () =>
      `block-${++id}`,
    );
    expect(mobileAgentOutputTitle('# Concise answer')).toBe('Concise answer');
    expect(JSON.parse(prose)).toMatchObject({
      content: [
        { attrs: { id: 'block-1' }, content: [{ text: 'First paragraph' }] },
        { attrs: { id: 'block-2' }, content: [{ text: 'Second paragraph' }] },
      ],
    });
  });
});
