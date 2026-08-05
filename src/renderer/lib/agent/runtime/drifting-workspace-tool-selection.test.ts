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
  definition('browse_project', 'read'),
  definition('read_object', 'read'),
  definition('search_work', 'read'),
  definition('revise_object', 'write'),
  definition('write_object', 'write'),
  definition('delete_object', 'write'),
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
  it('shows only the authored-object facade for an ordinary prose edit', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('随便找个章节润色一下'),
    );
    expect(selected).toEqual([
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
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
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
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
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
      'ask_user',
    ]);
  });

  it('keeps a small explicit chapter range on the ordinary streaming edit surface', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('第七章到第十章整体有点散。收拾到能顺着往下写，摘要一起补好，最后自己检查。'),
    );

    expect(selected).toEqual([
      'read_object',
      'write_object',
      'revise_object',
      'ask_user',
    ]);
  });

  it('offers durable planning for a genuinely long explicit chapter range', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('第一章到第八章都整理一遍，摘要也补齐。'),
    );

    expect(selected).toEqual([
      'update_task_plan',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
      'ask_user',
    ]);
  });

  it('does not mistake 开头六章 for a direct request targeting only 第六章', () => {
    const strategy = createDriftingWorkspaceToolSelectionStrategy();
    const initialRequest = request(
        '把开头六章和相关设定彻底顺一遍。该润色的润色，摘要该补的补；把奥伦、凯尔、米拉、伊莱亚斯之间的关系和待办也整理好，缺什么就建，明显的测试垃圾就删。最后自己复查一遍，没做完别停。',
      );
    const selected = strategy.select(initialRequest);

    expect(selected).toEqual([
      'update_task_plan',
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
      'ask_user',
    ]);
    expect(strategy.forceTool?.(initialRequest, selected)).toBeNull();

    const catalogRequest = request(
      'original request:\n把开头六章和相关设定彻底顺一遍。该润色的润色，摘要该补的补；把奥伦、凯尔、米拉、伊莱亚斯之间的关系和待办也整理好，缺什么就建，明显的测试垃圾就删。最后自己复查一遍，没做完别停。\nrecent work:\n现有章节\n章节「00」\n章节「01」\n章节「03」\n章节「04」\n章节「05」\n章节「06」',
    );
    catalogRequest.iteration = 3;
    const catalogSelected = strategy.select(catalogRequest);
    expect(strategy.forceTool?.(catalogRequest, catalogSelected)).toBe('update_task_plan');
  });

  it('offers durable planning for a fuzzy multi-stage campaign without an explicit chapter count', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        '把开头和相关设定彻底整理完，该删的临时稿删掉，该补的人物、关系和待办补齐，再把正文往后写到一个自然停点。自己检查，没做完就继续。',
      ),
    );

    expect(selected).toEqual([
      'update_task_plan',
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
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
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
      'ask_user',
    ]);
  });

  it('forces an early checklist for a named multi-character cleanup campaign', () => {
    const strategy = createDriftingWorkspaceToolSelectionStrategy();
    const input = request(
      '把奥伦、凯尔、米拉、伊莱亚斯这组人物档案整理到能用：根据开头相关章节补全资料和核心关系，把明显乱码或测试留下的关系、批注和空壳实体清掉；拿不准但需要后续处理的建待办。做完自己检查。',
    );
    const selected = strategy.select(input);

    expect(selected).toEqual(['update_task_plan']);
    expect(strategy.forceTool?.(input, selected)).toBe('update_task_plan');
  });

  it('recognizes the natural 前半本 phrasing used by the post-fix paid stress run', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        '前半本现在还不能直接接着写。把它彻底收拾好：该补的补、该删的删，正文、人物资料、批注待办和关系都一起处理，推进到一个自然停点。你自己判断做到什么程度，最后复查；没做完就继续。',
      ),
    );

    expect(selected).toEqual([
      'update_task_plan',
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
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
      'update_task_plan',
      'update_task_step',
      'browse_project',
      'read_object',
      'search_work',
      'write_object',
      'revise_object',
      'delete_object',
    ]);
  });

  it('pairs an active durable step with authored-object read and edit', () => {
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
      'update_task_plan',
      'update_task_step',
      'read_object',
      'write_object',
      'revise_object',
      'delete_object',
      'ask_user',
    ]);
  });

  it('does not expose later cleanup discovery while the current element is being completed', () => {
    const input = request(
      '把奥伦、凯尔、米拉、伊莱亚斯的档案补全，再清理测试关系和空壳实体。',
    );
    input.hints = {
      longTask: {
        status: 'active',
        scopeKind: 'explicit_targets',
        objective: '补全四个人物档案并清理测试残留',
        nextStep: {
          title: '补全奥伦人物资料与核心关系',
          status: 'pending',
          target: { kind: 'element', name: '奥伦' },
        },
      },
    };

    expect(createDriftingWorkspaceToolSelectionStrategy().select(input)).toEqual([
      'update_task_plan',
      'update_task_step',
      'read_object',
      'write_object',
      'revise_object',
      'delete_object',
      'ask_user',
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
      'update_task_plan',
      'update_task_step',
      'browse_project',
      'read_object',
      'search_work',
      'write_object',
      'revise_object',
      'delete_object',
    ]);
  });

  it('does not mistake prior result text for author intent', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        'original request:\n请浏览章节并给出建议，不要修改任何内容。\nrecent work:\n现有批注可以阅读，也可以修改',
      ),
    );
    expect(selected).toEqual(['browse_project', 'read_object', 'search_work', 'ask_user']);
    expect(selected).not.toContain('revise_object');
    expect(selected).not.toContain('get_overview');
    expect(selected).not.toContain('create_comment');
  });

  it('keeps revise_object available for a scoped negative instruction', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('在第十二章开头插入一个独立段落，不要修改其他内容。'),
    );
    expect(selected).toContain('revise_object');
    expect(selected).not.toContain('browse_project');
  });

  it('opens an explicitly named chapter without exposing project inventory first', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('第六章读起来有点散，帮我收紧一下，把人物动机和前后衔接顺一遍。'),
    );
    expect(selected).toEqual([
      'read_object',
      'write_object',
      'revise_object',
      'ask_user',
    ]);
  });

  it('keeps a named chapter cleanup on the authored read and edit surface', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('第八章有点松散，清掉明显测试痕迹，收紧正文，摘要也同步。'),
    );
    expect(selected).toEqual(['read_object', 'write_object', 'revise_object', 'ask_user']);
  });

  it('restores discovery after a directly named target cannot be resolved', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        'original request:\n润色第六章。\nrecent work:\n第六章 not found',
      ),
    );
    expect(selected).toContain('browse_project');
  });

  it('restores discovery after the semantic reader reports a missing chapter', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        'original request:\n整理第十三章。\nrecent work:\n未找到第十三章。当前作品已有章节：章节「12」。第十三章尚未创建。',
      ),
    );
    expect(selected).toContain('browse_project');
  });

  it('does not turn a stale paragraph edit into project-wide discovery', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        'original request:\n收紧第九章并同步摘要。\nrecent work:\n目标段落已变化，未能应用这处局部修改。',
      ),
    );
    expect(selected).toEqual(['read_object', 'write_object', 'revise_object', 'ask_user']);
  });

  it('keeps write_object and revise_object together for a mixed object mutation turn', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('先局部修改正文，再设置完整摘要。'),
    );
    expect(selected).toEqual([
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
      'ask_user',
    ]);
  });

  it('keeps both mutation verbs available for an ambiguous follow-up edit', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(request('改一下内容。'));
    expect(selected).toEqual([
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
      'ask_user',
    ]);
  });

  it('keeps delete_object available for a vague executable continuation', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('继续，别再从头看了。'),
    );
    expect(selected).toEqual([
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
      'ask_user',
    ]);
  });

  it('routes comment and TODO CRUD through the workspace facade', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('把这个 TODO 标记为已完成'),
    );
    expect(selected).toContain('write_object');
    expect(selected).not.toContain('create_comment');
  });

  it('keeps revise_object visible for a compound create plus comment task', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request(
        '创建一条灵感和两个实体，添加关系、批注与待办；不要修改任何现有章节。完成后回读并修正发现的问题。',
      ),
    );
    expect(selected).toEqual([
      'browse_project',
      'read_object',
      'write_object',
      'delete_object',
      'search_work',
      'revise_object',
      'ask_user',
    ]);
  });

  it('does not expose mutation verbs for read-only comment analysis', () => {
    const selected = createDriftingWorkspaceToolSelectionStrategy().select(
      request('只阅读并分析现有批注，不要修改任何内容。'),
    );
    expect(selected).toEqual(['browse_project', 'read_object', 'search_work', 'ask_user']);
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
