import { describe, expect, it } from 'vitest';

import { createDriftingWorkspaceToolSelectionStrategy } from './drifting-workspace-tool-selection';
import type {
  AgentToolDefinition,
  AgentToolSelectionRequest,
} from './types';

const definition = (name: string, access: 'read' | 'write'): AgentToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  access,
  validateInput: (value) => ({ ok: true, value }),
});

const definitions = [
  definition('list_files', 'read'),
  definition('read_file', 'read'),
  definition('grep', 'read'),
  definition('edit_file', 'write'),
  definition('ask_user', 'read'),
  definition('read_task_plan', 'read'),
  definition('update_task_plan', 'write'),
  definition('update_task_step', 'write'),
  definition('update_task_constraint', 'write'),
  definition('read_node', 'read'),
  definition('edit_block', 'write'),
  definition('get_overview', 'read'),
  definition('create_comment', 'write'),
];

describe('Drifting workspace-first tool selection', () => {
  it('shows only the filesystem facade for an ordinary prose edit', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('随便找个章节润色一下'),
    );
    expect(selected).toEqual([
      'list_files',
      'read_file',
      'grep',
      'edit_file',
      'ask_user',
    ]);
    expect(selected).not.toContain('read_node');
    expect(selected).not.toContain('edit_block');
  });

  it('uses the first iteration to create a durable whole-book plan', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('保持第一人称，润色整本小说'),
    );
    expect(selected).toEqual([
      'update_task_plan',
      'update_task_constraint',
      'list_files',
      'read_file',
      'grep',
    ]);
  });

  it('pairs an active durable step with workspace read and edit', () => {
    const input = request('继续');
    input.hints = {
      longTask: {
        status: 'active',
        scopeKind: 'whole_book_chapters',
        objective: '润色整本小说',
        nextStep: {
          title: '润色第一章',
          status: 'pending',
          target: { kind: 'chapter', name: '第一章' },
        },
      },
    };
    expect(createDriftingWorkspaceToolSelectionStrategy().select(input)).toEqual([
      'read_task_plan',
      'update_task_step',
      'list_files',
      'read_file',
      'edit_file',
    ]);
  });

  it('does not mistake workspace result text for author intent', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        'original request:\n请浏览章节并给出建议，不要修改任何内容。\nrecent work:\n/comments.json Editorial comments; writable edit files',
      ),
    );
    expect(selected).toEqual(['list_files', 'read_file', 'grep', 'ask_user']);
    expect(selected).not.toContain('edit_file');
    expect(selected).not.toContain('get_overview');
    expect(selected).not.toContain('create_comment');
  });
});

function request(query: string): AgentToolSelectionRequest {
  return {
    definitions,
    context: { route: { kind: 'chat', projectId: 'project' } },
    iteration: 0,
    hints: {},
    query,
    successfulReadNamesInPreviousBatch: [],
    successfulReadNamesSinceLastWrite: [],
    pendingResultPage: false,
    limit: 8,
  };
}
