import { describe, expect, it } from 'vitest';

import type { AgentAuthoringFocus } from './writing-intelligence';
import { buildAgentWritingTurnContext } from './writing-intelligence';
import { validateAgentWritingScope } from './writing-scope-guard';
import type { AgentToolExecutionRequest } from './types';

const focus: AgentAuthoringFocus = {
  projectId: 'scope-project',
  entity: {
    kind: 'chapter',
    id: 'chapter-one',
    name: '第一章',
    path: '/chapters/第一章/prose.md',
  },
  mode: 'selection',
  selectedText: '只改这一句话。',
  selectedBlocks: [{ id: 'block-2', ordinal: 2, text: '只改这一句话。' }],
  contextBefore: ['不要碰这一段。'],
  contextAfter: ['也不要碰这一段。'],
};

function request(input: {
  writing: ReturnType<typeof buildAgentWritingTurnContext>;
  name?: string;
  arguments: Record<string, unknown>;
}): AgentToolExecutionRequest {
  return {
    sessionId: 'session-scope',
    turnId: 'turn-scope',
    callId: 'call-scope',
    idempotencyKey: 'session-scope:turn-scope:call-scope',
    name: input.name ?? 'edit_file',
    arguments: input.arguments,
    access: 'write',
    context: {
      route: { kind: 'chat', projectId: 'scope-project' },
      writing: input.writing,
    },
    signal: new AbortController().signal,
  };
}

function preparedEdit(
  path: string,
  replacements: Array<{ oldText: string; newText: string }>,
): Record<string, unknown> {
  return {
    path,
    replacements,
    __workspaceCommand: {
      name: 'edit_prose_file',
      arguments: {
        entity: path.includes('第一章') ? '第一章' : '第二章',
        kind: 'chapter',
        replacements,
      },
    },
  };
}

describe('writing scope guard', () => {
  it('allows an exact replacement wholly inside the selected text', () => {
    const writing = buildAgentWritingTurnContext('润色这里。', focus);
    expect(
      validateAgentWritingScope(
        request({
          writing,
          arguments: preparedEdit('/chapters/第一章/prose.md', [
            { oldText: '这一句话', newText: '这一句' },
          ]),
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('rejects edits to another entity and text outside the selection', () => {
    const writing = buildAgentWritingTurnContext('润色这里。', focus);
    expect(
      validateAgentWritingScope(
        request({
          writing,
          arguments: preparedEdit('/chapters/第二章/prose.md', [
            { oldText: '另一个段落', newText: '被越界修改' },
          ]),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'WRITING_SCOPE_ENTITY_MISMATCH' });
    expect(
      validateAgentWritingScope(
        request({
          writing,
          arguments: preparedEdit('/chapters/第一章/prose.md', [
            { oldText: '不要碰这一段', newText: '越界' },
          ]),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'WRITING_SCOPE_SELECTION_MISMATCH' });
  });

  it('rejects whole-file writes and direct block writes for a partial selection', () => {
    const writing = buildAgentWritingTurnContext('重写这句话。', focus);
    expect(
      validateAgentWritingScope(
        request({
          writing,
          name: 'write_file',
          arguments: {
            path: '/chapters/第一章/prose.md',
            content: '整章被替换',
            __workspaceCommand: {
              name: 'edit_prose_file',
              arguments: { entity: '第一章', kind: 'chapter', content: '整章被替换' },
            },
          },
        }),
      ),
    ).toMatchObject({ ok: false, code: 'WRITING_SCOPE_SELECTION_MISMATCH' });
    expect(
      validateAgentWritingScope(
        request({
          writing,
          name: 'edit_block',
          arguments: { entity: '第一章', kind: 'chapter', blockId: 'block-2', text: '整段' },
        }),
      ),
    ).toMatchObject({ ok: false, code: 'WRITING_SCOPE_SELECTION_MISMATCH' });
  });

  it('allows whole-entity work only when the author explicitly says current chapter', () => {
    const writing = buildAgentWritingTurnContext('重写本章。', focus);
    expect(writing.intent.scopeKind).toBe('focus_entity');
    expect(
      validateAgentWritingScope(
        request({
          writing,
          name: 'write_file',
          arguments: {
            path: '/chapters/第一章/prose.md',
            content: '整章新稿',
            __workspaceCommand: {
              name: 'edit_prose_file',
              arguments: { entity: '第一章', kind: 'chapter', content: '整章新稿' },
            },
          },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('blocks unresolved prose writes but leaves explicit resource creation available', () => {
    const unresolved = buildAgentWritingTurnContext('重写这里。', null);
    expect(
      validateAgentWritingScope(
        request({
          writing: unresolved,
          arguments: preparedEdit('/chapters/第一章/prose.md', [
            { oldText: '原文', newText: '新文' },
          ]),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'WRITING_SCOPE_UNRESOLVED' });

    const create = buildAgentWritingTurnContext('创建一个名为尾声的新章节。', null);
    expect(
      validateAgentWritingScope(
        request({
          writing: create,
          name: 'write_file',
          arguments: {
            path: '/chapters/尾声/prose.md',
            content: '尾声正文',
            __workspaceCommand: {
              name: 'create_node',
              arguments: { title: '尾声', kind: 'chapter', prose: '尾声正文' },
            },
          },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('fails closed when an explicit canon evolution tries to write prose directly', () => {
    const writing = buildAgentWritingTurnContext(
      '修改设定：让留存者议会推翻南园的旧契约，并据此改剧情。',
      focus,
      ['留存者议会', '南园'],
    );
    expect(
      validateAgentWritingScope(
        request({
          writing,
          arguments: preparedEdit('/chapters/第一章/prose.md', [
            { oldText: '只改这一句话', newText: '议会已经推翻了旧契约' },
          ]),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'WRITING_CANON_PATCH_REQUIRED' });
  });

  it('allows explicitly named entities without editor focus and rejects a substituted target', () => {
    const writing = buildAgentWritingTurnContext(
      '重写第一章。',
      null,
      [],
      [
        {
          entity: focus.entity,
          terms: ['第一章'],
        },
      ],
    );
    expect(writing).toMatchObject({
      intent: { scopeKind: 'explicit', clarificationRequired: false },
      resolvedTargets: [focus.entity],
    });
    expect(
      validateAgentWritingScope(
        request({
          writing,
          arguments: preparedEdit('/chapters/第一章/prose.md', [
            { oldText: '原文', newText: '新文' },
          ]),
        }),
      ),
    ).toEqual({ ok: true });
    expect(
      validateAgentWritingScope(
        request({
          writing,
          arguments: preparedEdit('/chapters/第二章/prose.md', [
            { oldText: '原文', newText: '越权改写' },
          ]),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'WRITING_SCOPE_ENTITY_MISMATCH' });
  });
});
