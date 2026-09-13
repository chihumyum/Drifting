import type { RevertRecord } from '../../../store/agent-edit-store';
import { loadActiveMemoryHints } from '../../../usecase/useAgentMemory';
import { prepareAgentWorkingMemoryForTurn } from '../../../usecase/useAgentWorkingMemory';

/** Prepare context only while the submitting intent owns preparation. Existing
 * repository work may settle, but cannot start the next step or consume reviews. */
export async function prepareAgentChatMemories(projectId: string, isCurrent: () => boolean) {
  if (!isCurrent()) return null;
  const memories = await loadActiveMemoryHints(projectId).catch(() => []);
  if (!isCurrent()) return null;
  const workingMemory = await prepareAgentWorkingMemoryForTurn(projectId).catch(() => null);
  if (!isCurrent()) return null;
  return { memories, workingMemory: workingMemory
    ? { contentMd: workingMemory.contentMd, revision: workingMemory.revision, approxTokens: workingMemory.approxTokens }
    : { contentMd: '', revision: 0, approxTokens: 0 } };
}

/** A system note (zh-CN) telling the agent which of its edits the user rejected
 *  since the last turn, so it works from the restored text instead of believing
 *  its edits stuck (it ran bypassPermissions). Prepended to the next prompt. */
export function buildAgentChatRevertNote(reverts: RevertRecord[], entityDisplayName: (entityType: RevertRecord['entityType'], id: string) => string): string {
  const clamp = (t: string): string => (t.length > 200 ? `${t.slice(0, 200)}…` : t);
  const lines = reverts.map((rv) => {
    const name = `《${entityDisplayName(rv.entityType, rv.id)}》`;
    // Non-prose field edits (summary / kv / template kv) name the field.
    if (rv.field) {
      const f = rv.field;
      // Patch review: rejecting a CREATE deletes it; a DELETE keeps it; an
      // UPDATE restores the pre-edit title/body.
      if (f.kind === 'patch') {
        if (rv.op === 'deleted')
          return `- 你删除的${name}的补丁「${f.label}」已被用户保留（未删除）。`;
        if (rv.op === 'changed')
          return `- 你对${name}的补丁「${f.label}」的修改已被用户撤销，已还原为改动前的内容。`;
        return `- 你为${name}创建的补丁「${f.label}」已被用户删除。`;
      }
      const fieldLabel =
        f.kind === 'summary'
          ? '摘要'
          : f.kind === 'group'
            ? '分组'
            : f.kind === 'kv'
              ? `字段「${f.key ?? ''}」`
              : f.kind === 'templatekv'
                ? `模版字段「${f.key ?? ''}」`
                : '字段';
      if (rv.op === 'new') return `- 你为${name}新增的${fieldLabel}已被用户撤销（删除）。`;
      if (rv.op === 'deleted')
        return `- 你删除的${name}的${fieldLabel}已被用户恢复为：「${clamp(rv.restoredText)}」。`;
      return `- 你对${name}的${fieldLabel}的修改已被用户拒绝，已恢复为：「${clamp(rv.restoredText)}」。`;
    }
    if (rv.op === 'new') return `- 你在${name}中新增的一个段落已被用户撤销（删除）。`;
    if (rv.op === 'deleted')
      return `- 你在${name}中删除的段落已被用户恢复为原文：「${clamp(rv.restoredText)}」。`;
    return `- 你在${name}中的一处改写已被用户拒绝，已恢复为原文：「${clamp(rv.restoredText)}」。`;
  });
  return `【系统提示】自你上一轮之后，用户拒绝并还原了以下改动。请以还原后的文本为当前内容，未经用户明确要求不要重新应用这些改动：\n${lines.join('\n')}`;
}
