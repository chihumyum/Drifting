import { describe, expect, it, vi } from 'vitest';
import type { ImageGenerationResult, ImageInboxEntry } from '../../../platform';
import {
  markElementImageConversation,
  rememberElementImageRequest,
} from '../element-image-requests';
import {
  AgentElementImageToolRuntime,
  ELEMENT_IMAGE_TOOL_NAME,
  createElementImageAwarePermissionPolicy,
  resolveAgentElementImageToolAccess,
  type ElementImageToolRuntimeOptions,
} from './element-image-tool-runtime';
import type {
  AgentToolExecutionRequest,
  AgentToolPermissionPolicy,
  AgentToolPermissionPolicyRequest,
} from './types';

function candidate(id: string): ImageInboxEntry {
  return {
    id,
    projectId: 'project-1',
    target: { kind: 'element', id: 'element-1' },
    createdAtMs: 1,
    mime: 'image/png',
    width: 1024,
    height: 1536,
    sizeBytes: 10,
    filePath: `/inbox/${id}/image.png`,
    fileUrl: `asset://${id}`,
    provenance: {
      provider: 'chatgpt-subscription',
      model: 'gpt-image-2',
      prompt: 'p',
      subjectPrompt: 'p',
      styleText: null,
      extraPrompt: null,
      conversationId: null,
      generationId: null,
      imagegenRequestId: null,
    },
  };
}

function request(
  args: Record<string, unknown>,
  overrides: Partial<AgentToolExecutionRequest> = {},
): AgentToolExecutionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId: 'call-1',
    idempotencyKey: 'effect-1',
    name: ELEMENT_IMAGE_TOOL_NAME,
    arguments: args,
    access: 'write',
    context: { route: { kind: 'chat', projectId: 'project-1', conversationId: 'conversation-1' } },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function runtime(overrides: Partial<ElementImageToolRuntimeOptions> = {}) {
  const result: ImageGenerationResult = {
    candidates: [candidate('c1'), candidate('c2')],
    failures: [],
    quota: { limit: 'imagegen_premium', usedPercent: 3, windowMinutes: 1440, resetsAtMs: 0 },
  };
  const options: ElementImageToolRuntimeOptions = {
    generate: vi.fn(async () => result),
    resolveElement: vi.fn((projectId: string, elementId: string) =>
      projectId === 'project-1' && elementId === 'element-1' ? { id: 'element-1', name: '灯塔看守人' } : null,
    ),
    getArtStyle: vi.fn(() => '低饱和水彩'),
    onCandidates: vi.fn(),
    ...overrides,
  };
  return { runtime: new AgentElementImageToolRuntime(options), options };
}

describe('generate_element_images', () => {
  it('is one write tool that stays outside the shared write barrier', () => {
    const [definition] = runtime().runtime.listDefinitions();
    expect(definition).toMatchObject({
      name: ELEMENT_IMAGE_TOOL_NAME,
      access: 'write',
      scheduling: 'independent',
    });
    expect(resolveAgentElementImageToolAccess(ELEMENT_IMAGE_TOOL_NAME)).toBe('write');
    expect(resolveAgentElementImageToolAccess('read_element')).toBeUndefined();
  });

  it.each([
    {},
    { elementId: 'element-1' },
    { elementId: 'element-1', prompt: '' },
    { elementId: 'element-1', prompt: 'x', count: 5 },
    { elementId: 'element-1', prompt: 'x', style: 'oil' },
  ])('rejects invalid arguments: %j', (args) => {
    const [definition] = runtime().runtime.listDefinitions();
    expect(definition.validateInput(args)).toMatchObject({ ok: false });
  });

  it('appends the art style, records the author request and hands candidates to the page', async () => {
    rememberElementImageRequest('element-1', { count: 3, extraPrompt: '穿旧大衣' });
    const { runtime: tool, options } = runtime();

    const result = await tool.execute(request({ elementId: 'element-1', prompt: '  白发老人，提灯  ' }));

    expect(options.generate).toHaveBeenCalledWith(
      {
        projectId: 'project-1',
        target: { kind: 'element', id: 'element-1' },
        prompt: '白发老人，提灯\n\n画风：低饱和水彩',
        count: 3,
        provenance: {
          subjectPrompt: '白发老人，提灯',
          styleText: '低饱和水彩',
          extraPrompt: '穿旧大衣',
          conversationId: 'conversation-1',
        },
      },
      expect.any(AbortSignal),
    );
    expect(options.onCandidates).toHaveBeenCalledWith(
      'project-1',
      [expect.objectContaining({ id: 'c1' }), expect.objectContaining({ id: 'c2' })],
      expect.objectContaining({ usedPercent: 3 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelData).toContain('Generated 2 image candidate(s) for element "灯塔看守人"');
      expect(result.modelData).toContain('Image limit used: 3%');
      expect(String(result.modelData)).not.toContain('/inbox/');
      expect(String(result.modelData)).not.toContain('asset://');
    }
  });

  it('refuses an element outside the route project without generating', async () => {
    const { runtime: tool, options } = runtime();
    const result = await tool.execute(request({ elementId: 'element-2', prompt: 'x' }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('ELEMENT_NOT_FOUND');
    expect(options.generate).not.toHaveBeenCalled();
  });

  it('reports provider failures to the model and rethrows a stop', async () => {
    const failing = runtime({
      generate: vi.fn(async () => {
        throw new Error('CODEX_IMAGES_USAGE_LIMIT: image limit reached');
      }),
    });
    await expect(
      failing.runtime.execute(request({ elementId: 'element-1', prompt: 'x' })),
    ).resolves.toEqual({ ok: false, error: 'CODEX_IMAGES_USAGE_LIMIT: image limit reached' });

    const controller = new AbortController();
    const stopped = runtime({
      generate: vi.fn(async () => {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      }),
    });
    await expect(
      stopped.runtime.execute(
        request({ elementId: 'element-1', prompt: 'x' }, { signal: controller.signal }),
      ),
    ).rejects.toBeTruthy();
    expect(stopped.options.onCandidates).not.toHaveBeenCalled();
  });

  it('runs unprompted only in conversations the element page started', async () => {
    const fallback: AgentToolPermissionPolicy = {
      decide: vi.fn(async () => ({ decision: 'allow' as const, scope: 'once' as const })),
    };
    const policy = createElementImageAwarePermissionPolicy(fallback);
    const ask = (conversationId: string, overrides: Partial<AgentToolPermissionPolicyRequest> = {}) =>
      policy.decide({
        requestId: 'r',
        sessionId: 's',
        turnId: 't',
        callId: 'c',
        toolName: ELEMENT_IMAGE_TOOL_NAME,
        access: 'write',
        arguments: {},
        argumentsHash: 'h',
        revision: null,
        allowedScopes: ['once'],
        context: { route: { kind: 'chat', projectId: 'project-1', conversationId } },
        ...overrides,
      });

    await expect(ask('chat-1')).resolves.toMatchObject({ decision: 'ask', allowedScopes: ['once'] });
    markElementImageConversation('page-1');
    await expect(ask('page-1')).resolves.toEqual({ decision: 'allow', scope: 'once' });
    await expect(ask('page-1', { access: 'read' })).resolves.toMatchObject({ decision: 'deny' });
    await ask('page-1', { toolName: 'read_element', access: 'read' });
    expect(fallback.decide).toHaveBeenCalledTimes(1);
  });
});
