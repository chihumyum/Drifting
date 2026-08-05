import { describe, expect, it } from 'vitest';

import type { Project } from '../../../../domain/project';
import { buildGeneralAgentProjectContext } from '../../product-project-context';
import { buildDriftingAgentCapabilityManifest } from '../drifting-agent-capability-manifest';
import {
  AGENT_AUTHOR_CONTROL_CONTRACT,
  buildDriftingAgentSystemPrompt,
} from '../system-prompt';

const route = {
  kind: 'chat' as const,
  projectId: 'author-control-project',
  conversationId: 'author-control-conversation',
};

describe('Milestone H replacement: author-owned writing policy', () => {
  it('removes product-derived editor focus and default literary rules', () => {
    const system = buildDriftingAgentSystemPrompt(
      { prompt: '写个500字的任意内容追加在这个灵感后面。', projectName: '自由写作' },
      route,
    );

    expect(system).toContain('Use any project object that helps fulfill the request.');
    expect(system).toContain('You may create, revise, reorganize, relate, or remove content');
    expect(system).not.toContain('internal writing scope');
    expect(system).not.toContain('Authoring-intent contract');
    expect(system).not.toContain('Current editor focus');
    expect(system).not.toContain('Nearby prose');
    expect(system).not.toContain('Preserve unless the author explicitly overrides it');
    expect(system).not.toContain('sanctioned patch');
    expect(system).not.toContain('Local voice witness');
  });

  it('injects only author-owned project facts and approved standing guidance', () => {
    const system = buildDriftingAgentSystemPrompt(
      {
        prompt: '继续工作。',
        projectName: '自由写作',
        projectFacts: [
          { key: '叙事规则', value: '可以自由改变 POV' },
          { key: 'Canon 规则', value: '正文优先于设定表' },
        ],
        memories: [
          { kind: 'directive', body: '允许主动重构时间线。' },
          { kind: 'veto', body: '不要使用全知旁白。' },
        ],
      },
      route,
    );

    expect(system).toContain('Author-defined project facts and rules:');
    expect(system).toContain('- 叙事规则: 可以自由改变 POV');
    expect(system).toContain('- Canon 规则: 正文优先于设定表');
    expect(system).toContain('Author-approved standing guidance:');
    expect(system).toContain('- [directive] 允许主动重构时间线。');
    expect(system).toContain('- [veto] 不要使用全知旁白。');
  });

  it('keeps project rules as ordinary author-editable project data', () => {
    const project = {
      id: route.projectId,
      name: '自由写作',
      kvJson: JSON.stringify([
        { key: '文风', value: '由用户决定' },
        { key: '时间线', value: '允许非线性' },
      ]),
    } as Project;

    expect(buildGeneralAgentProjectContext(route.projectId, project)).toEqual({
      projectName: '自由写作',
      projectFacts: [
        { key: '文风', value: '由用户决定' },
        { key: '时间线', value: '允许非线性' },
      ],
    });
  });

  it('publishes no hidden writing defaults or content mutation guards', () => {
    expect(AGENT_AUTHOR_CONTROL_CONTRACT).toEqual({
      productWritingDefaults: 'none',
      editorContextInjection: 'disabled',
      contentMutationScopeGuard: 'disabled',
      canonPatchGate: 'disabled',
      projectRules: 'author-editable-project-facts',
      standingGuidance: 'author-created-or-author-approved-active-memory',
      guidanceLifecycle: 'author-editable-and-deletable',
      executionSafety: 'data-integrity-review-and-destructive-confirmation-only',
    });
    expect(buildDriftingAgentCapabilityManifest().authorControl).toEqual(
      AGENT_AUTHOR_CONTROL_CONTRACT,
    );
  });
});
