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
      'delete_file',
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
      'write_file',
      'delete_file',
      'grep',
      'edit_file',
    ]);
  });

  it('treats a vague opening-chapters cleanup as a durable multi-resource task', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        '把这本书开头几章整体收拾顺，前后别打架。该补的过渡、人物和关系就补上，明显是测试留下的内容就删掉。做完以后自己从头检查一遍，别停在半成品。',
      ),
    );

    expect(selected).toEqual([
      'update_task_plan',
      'list_files',
      'read_file',
      'write_file',
      'delete_file',
      'grep',
      'edit_file',
      'ask_user',
    ]);
  });

  it('offers durable planning for a fuzzy multi-stage campaign without an explicit chapter count', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        '把开头和相关设定彻底整理完，该删的临时稿删掉，该补的人物、关系和待办补齐，再把正文往后写到一个自然停点。自己检查，没做完就继续。',
      ),
    );

    expect(selected).toEqual([
      'update_task_plan',
      'list_files',
      'read_file',
      'write_file',
      'delete_file',
      'grep',
      'edit_file',
      'ask_user',
    ]);
  });

  it('offers the durable ledger for the real fuzzy paid-stress prompt', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        '这本书前半段还是一团乱，收拾到可以直接接着写。缺的内容补起来，测试残留和重复资料清掉，批注、待办、人物关系都理顺，正文推进到一个合适的停点。你自己查、自己判断，最后从头复核；明显没收完就继续做。',
      ),
    );

    expect(selected).toEqual([
      'update_task_plan',
      'list_files',
      'read_file',
      'write_file',
      'delete_file',
      'grep',
      'edit_file',
      'ask_user',
    ]);
  });

  it('recognizes the natural 前半本 phrasing used by the post-fix paid stress run', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        '前半本现在还不能直接接着写。把它彻底收拾好：该补的补、该删的删，正文、人物资料、批注待办和关系都一起处理，推进到一个自然停点。你自己判断做到什么程度，最后复查；没做完就继续。',
      ),
    );

    expect(selected).toEqual([
      'update_task_plan',
      'list_files',
      'read_file',
      'write_file',
      'delete_file',
      'grep',
      'edit_file',
      'ask_user',
    ]);
  });

  it('retains deletion during the active phase of the real fuzzy campaign', () => {
    const input = request(
      '这本书前半段还是一团乱，测试残留和重复资料清掉，明显没收完就继续做。',
    );
    input.hints = {
      longTask: {
        status: 'active',
        scopeKind: 'explicit_targets',
        objective: '整理前半段并清掉测试残留',
        nextStep: {
          title: '整理章节和关联资料',
          status: 'pending',
          target: null,
        },
      },
    };

    expect(createDriftingWorkspaceToolSelectionStrategy().select(input)).toEqual([
      'read_task_plan',
      'update_task_plan',
      'update_task_step',
      'list_files',
      'read_file',
      'delete_file',
      'write_file',
      'edit_file',
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
      'update_task_plan',
      'update_task_step',
      'list_files',
      'read_file',
      'write_file',
      'grep',
      'edit_file',
    ]);
  });

  it('keeps delete and edit available for an active cleanup step within the eight-tool cap', () => {
    const input = request('继续清理测试残留');
    input.hints = {
      longTask: {
        status: 'active',
        scopeKind: 'whole_book_chapters',
        objective: '整理开头几章并删除测试残留',
        nextStep: {
          title: '清理残留并修正文稿',
          status: 'pending',
          target: null,
        },
      },
    };
    expect(createDriftingWorkspaceToolSelectionStrategy().select(input)).toEqual([
      'read_task_plan',
      'update_task_plan',
      'update_task_step',
      'list_files',
      'read_file',
      'delete_file',
      'write_file',
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
      'delete_file',
      'grep',
      'edit_file',
      'ask_user',
    ]);
  });

  it('keeps both mutation verbs available for an ambiguous follow-up edit', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(request('改一下内容。'));
    expect(selected).toEqual([
      'list_files',
      'read_file',
      'write_file',
      'delete_file',
      'grep',
      'edit_file',
      'ask_user',
    ]);
  });

  it('keeps delete_file available for a vague executable continuation', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('继续，别再从头看了。'),
    );
    expect(selected).toEqual([
      'list_files',
      'read_file',
      'write_file',
      'delete_file',
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

  it('keeps edit_file visible for a compound create plus comment task', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        '创建一条灵感和两个实体，添加关系、批注与待办；不要修改任何现有章节。完成后回读并修正发现的问题。',
      ),
    );
    expect(selected).toEqual([
      'list_files',
      'read_file',
      'write_file',
      'delete_file',
      'grep',
      'edit_file',
      'ask_user',
    ]);
  });

  it('does not expose mutation verbs for read-only comment analysis', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('只阅读并分析现有批注，不要修改任何内容。'),
    );
    expect(selected).toEqual(['list_files', 'read_file', 'grep', 'ask_user']);
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

  it('treats appending to an existing patch title as an update', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        '读取 Grey Banker 的元素补丁，选择第一条，在原标题末尾追加一个标记。不要创建替代实体。',
      ),
    );
    expect(selected).toContain('get_element_patches');
    expect(selected).toContain('update_element_patch');
    expect(selected).not.toContain('create_element_patch');
  });

  it('does not recall destructive tools from a negated mutation', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('修改柳青的元素补丁，不要删除任何补丁。'),
    );
    expect(selected).toContain('update_element_patch');
    expect(selected).not.toContain('delete_element_patch');
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
