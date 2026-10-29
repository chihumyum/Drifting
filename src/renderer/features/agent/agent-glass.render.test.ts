import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

import type { AgentChatMessage } from '../../domain/agent-conversation';
import type { AgentPendingControl } from '../../lib/agent/protocol';
import { MessageView, RuntimeControlCard } from './AgentMessageViews';
import { AgentGlassContext } from './agent-glass';

const onDesktop = (node: ReactElement) =>
  renderToStaticMarkup(createElement(AgentGlassContext.Provider, { value: true }, node));
const message = (msg: AgentChatMessage) => createElement(MessageView, { msg });

const readStep = (status: 'running' | 'ok'): AgentChatMessage => ({
  kind: 'tool',
  id: `read-${status}`,
  name: 'read_chapter',
  input: { chapter: '三 · 退潮' },
  phase: 'ready',
  status,
});

describe('the desktop Agent transcript in sand and glass', () => {
  it('sweeps in only a step that arrives while the Agent works', () => {
    const live = onDesktop(message(readStep('running')));
    expect(live).toContain('class="agt-tool glass glass--rest glass--still glass-sweep"');

    const fromHistory = onDesktop(message(readStep('ok')));
    expect(fromHistory).toContain('class="agt-tool glass glass--rest glass--still"');
    expect(fromHistory).not.toContain('glass-sweep');
  });

  it('lets a step that opens drift under the pointer and keeps a read-only step still', () => {
    const raw = onDesktop(
      message({ kind: 'tool', id: 'raw', name: 'custom_probe', input: { q: 1 }, phase: 'ready', status: 'ok', result: 'two hits' }),
    );
    expect(raw).toContain('class="agt-tool glass glass--rest glass--surface"');
    expect(raw).toContain('<details');
  });

  it('lays the sent words on the composer\'s rounded slip and says errors without a slab', () => {
    const sent = onDesktop(message({ kind: 'user', text: '对不上就直接改。' }));
    expect(sent).toContain('class="agt-user-bubble glass glass--rest glass--still"');

    const error = onDesktop(message({ kind: 'error', text: '模型服务暂时不可用' }));
    expect(error).toContain('class="agt-error"');
    expect(error).not.toContain('background');
  });

  it('keeps the plan as a read-only card with the resting line', () => {
    const plan = onDesktop(
      message({ kind: 'todos', items: [{ content: '核对潮汐表', status: 'completed', activeForm: '' }] } as AgentChatMessage),
    );
    expect(plan).toContain('class="agt-todos glass glass--rest glass--still"');
  });

  it('lets a request for leave drift until the author decides, its one primary action last', () => {
    const pending: AgentPendingControl = {
      sessionId: 's',
      turnId: 't',
      status: 'waiting_permission',
      requiresContinuation: false,
      permissionRequest: {
        requestId: 'r',
        sessionId: 's',
        turnId: 't',
        callId: 'c',
        toolName: 'replace_text',
        access: 'write',
        arguments: {},
        argumentsHash: 'h',
        revision: null,
        allowedScopes: ['once', 'session'],
      },
    };
    const card = onDesktop(
      createElement(RuntimeControlCard, { pending, onPermission: () => {}, onCancelRecovered: () => {} }),
    );
    expect(card).toContain('class="agt-control-card agt-control-card--glass glass glass--waiting"');
    const buttons = [...card.matchAll(/<button type="button" class="([^"]+)">([^<]+)<\/button>/g)].map(
      ([, className, label]) => [label, className],
    );
    expect(buttons).toEqual([
      ['agentPanel.control.deny', 'agt-btn glass glass--rest'],
      ['agentPanel.control.allow.session', 'agt-btn glass glass--rest'],
      ['agentPanel.control.allow.once', 'agt-btn glass glass--primary glass--waiting'],
    ]);
  });

  it('leaves the paused mobile shell its own look', () => {
    const mobile = renderToStaticMarkup(message(readStep('running')));
    expect(mobile).not.toContain('glass');
    expect(renderToStaticMarkup(message({ kind: 'user', text: 'hi' }))).not.toContain('glass');
  });
});
