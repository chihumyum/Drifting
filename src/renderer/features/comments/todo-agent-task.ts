import {
  extractTextFromCommentBody,
  getSelectedTextFromAnchor,
  type Comment,
} from '../../domain/comment';

export function buildTodoAgentTask(comment: Comment, targetName: string | null) {
  const body = extractTextFromCommentBody(comment.bodyJson).trim();
  if (comment.kind !== 'todo' || comment.status !== 'open' || !body) return null;
  const excerpt = getSelectedTextFromAnchor(comment.anchorJson).trim();
  const title = `处理 TODO：${body.replace(/\s+/gu, ' ').slice(0, 30)}`;
  const prompt = [
    '请处理作者从 TODO 发起的独立任务：',
    body,
    targetName ? `关联作品对象：${targetName}` : '',
    excerpt ? `创建 TODO 时关联的原文片段：${excerpt}` : '',
    '先读取当前作品状态；关联原文可能已经变化。完成实际工作后说明结果。这个 TODO 留给作者确认，不要自行标记为已解决。',
  ].filter(Boolean).join('\n\n');
  return { title, prompt };
}
