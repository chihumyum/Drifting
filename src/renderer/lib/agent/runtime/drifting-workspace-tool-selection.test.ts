import { describe, expect, it } from 'vitest';

import { createDriftingWorkspaceToolSelectionStrategy } from './drifting-workspace-tool-selection';
import type { AgentToolDefinition, AgentToolSelectionRequest } from './types';

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
  definition('write_file', 'write'),
  definition('delete_file', 'write'),
  definition('ask_user', 'read'),
  definition('read_task_plan', 'read'),
  definition('update_task_plan', 'write'),
  definition('update_task_step', 'write'),
  definition('update_task_constraint', 'write'),
  definition('read_node', 'read'),
  definition('edit_block', 'write'),
  definition('get_overview', 'read'),
  definition('create_comment', 'write'),
  definition('get_element_patches', 'read'),
  definition('create_element_patch', 'write'),
  definition('update_element_patch', 'write'),
  definition('delete_element_patch', 'write'),
];

describe('Drifting workspace-first tool selection', () => {
  it('shows only the filesystem facade for an ordinary prose edit', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('随便找个章节润色一下'),
    );
    expect(selected).toEqual([
      'list_files',
      'read_file',
      'write_file',
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

  it('keeps edit_file available for a scoped negative instruction', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('在第十二章开头插入一个独立段落，不要修改其他内容。'),
    );
    expect(selected).toContain('edit_file');
  });

  it('keeps write_file and edit_file together for a mixed file mutation turn', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('先用 edit_file 改正文，再用 write_file 设置 summary.md 的完整内容。'),
    );
    expect(selected).toEqual([
      'list_files',
      'read_file',
      'write_file',
      'grep',
      'edit_file',
      'ask_user',
    ]);
  });

  it('keeps both mutation verbs available for an ambiguous follow-up edit', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('改一下内容。'),
    );
    expect(selected).toEqual([
      'list_files',
      'read_file',
      'write_file',
      'grep',
      'edit_file',
      'ask_user',
    ]);
  });

  it('routes comment and TODO CRUD through the workspace facade', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('把这个 TODO 标记为已完成'),
    );
    expect(selected).toContain('write_file');
    expect(selected).not.toContain('create_comment');
  });

  it('recalls the certified delete tool for an explicit element-patch deletion', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('删除柳青的这条元素补丁'),
    );
    expect(selected).toContain('get_element_patches');
    expect(selected).toContain('delete_element_patch');
    expect(selected).not.toContain('create_element_patch');
    expect(selected).not.toContain('update_element_patch');
  });

  it('does not let a scoped negative instruction turn patch creation into patch update', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('为柳青创建元素补丁，不要浏览或修改其他内容。'),
    );
    expect(selected).toContain('get_element_patches');
    expect(selected).toContain('create_element_patch');
    expect(selected).not.toContain('update_element_patch');
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
    repairToolNames: [],
    limit: 8,
  };
}
