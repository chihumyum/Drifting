import { describe, expect, it } from 'vitest';
import {
  agentTaskConversationId,
  createPlainCommentDoc,
  type Comment,
  type CommentAction,
} from '../../domain/comment';
import { buildTodoAgentTask } from './todo-agent-task';

const todo = {
  id: 'synthetic-todo',
  projectId: 'synthetic-project',
  kind: 'todo',
  status: 'open',
  bodyJson: createPlainCommentDoc('检查第十章结尾的时间线'),
  anchorJson: JSON.stringify({ selectedText: '第二天清晨' }),
} as Comment;

describe('Todo Agent handoff', () => {
  it('carries the task and its anchored evidence without treating the excerpt as current prose', () => {
    const task = buildTodoAgentTask(todo, '第十章');
    expect(task?.title).toContain('检查第十章结尾的时间线');
    expect(task?.prompt).toContain('关联作品对象：第十章');
    expect(task?.prompt).toContain('创建 TODO 时关联的原文片段：第二天清晨');
    expect(task?.prompt).toContain('关联原文可能已经变化');
    expect(task?.prompt).toContain('不要自行标记为已解决');
  });

  it('does not launch a resolved Todo or a note', () => {
    expect(buildTodoAgentTask({ ...todo, status: 'resolved' }, '第十章')).toBeNull();
    expect(buildTodoAgentTask({ ...todo, kind: 'note' }, '第十章')).toBeNull();
  });

  it('resolves the latest valid linked conversation for this Todo', () => {
    const base = {
      commentId: todo.id,
      kind: 'start_agent_task',
      status: 'applied',
      resultJson: JSON.stringify({ conversationId: 'first-conversation' }),
    } as CommentAction;
    const actions = [
      base,
      { ...base, commentId: 'another-todo', resultJson: JSON.stringify({ conversationId: 'other' }) },
      { ...base, resultJson: 'malformed JSON' },
      { ...base, status: 'failed', resultJson: JSON.stringify({ conversationId: 'failed-conversation' }) },
      { ...base, resultJson: JSON.stringify({ conversationId: 'latest-conversation' }) },
    ];
    expect(agentTaskConversationId(actions, todo.id)).toBe('latest-conversation');
    expect(agentTaskConversationId(actions, 'missing-todo')).toBeNull();
  });
});
