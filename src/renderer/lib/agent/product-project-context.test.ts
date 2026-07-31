import { describe, expect, it } from 'vitest';
import type { Project } from '../../domain/project';
import { buildGeneralAgentProjectContext } from './product-project-context';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-canonical',
    userId: 'user-1',
    name: '雾港档案',
    summary: '',
    kvJson: JSON.stringify([{ key: 'POV', value: '第三人称限知' }]),
    storylineTemplateKvJson: '[]',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('General Agent canonical project context', () => {
  it('passes the canonical project name and facts for the owning project', () => {
    expect(
      buildGeneralAgentProjectContext('project-canonical', project()),
    ).toEqual({
      projectName: '雾港档案',
      projectFacts: [{ key: 'POV', value: '第三人称限知' }],
    });
  });

  it('does not leak another project or substitute the opaque id as its name', () => {
    expect(
      buildGeneralAgentProjectContext(
        'project-active',
        project({ id: 'project-stale', name: '不应出现的书名' }),
      ),
    ).toEqual({ projectFacts: [] });
    expect(
      buildGeneralAgentProjectContext('project-active', null),
    ).toEqual({ projectFacts: [] });
  });
});
