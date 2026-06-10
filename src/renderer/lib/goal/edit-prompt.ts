/**
 * /goal 一键演化 — the edit task both editor engines (Agent SDK / Shadow-FC) run on:
 * what the setting changed to + the element's full current content + the
 * contradictions to fix in THIS chapter. Each engine appends its own tool guidance.
 */
import type { ElementChange, ContradictionSpot } from './types';

export function buildEditInstruction(
  chapterTitle: string,
  change: ElementChange,
  spots: ContradictionSpot[],
): string {
  const field = change.field ? `（${change.field}）` : '';
  const list = spots
    .map((s, i) => {
      const where = s.blockIds.length ? `第 ${s.blockIds.join('、')} 块` : '本章（整章级）';
      return `${i + 1}. ${where}：${s.reason}`;
    })
    .join('\n');
  return [
    `设定《${change.elementName}》${field}已更新：`,
    `  旧值：${change.oldSetting || '（未给）'}`,
    `  新值：${change.newSetting}`,
    '',
    change.profile ? `该设定的当前完整内容：\n${change.profile}\n` : '',
    `请在《${chapterTitle}》中，对下列与新设定冲突的位置做【最小】改动，使正文符合新设定。只改真正冲突处，不要顺手改写无关内容，不要新增设定以外的事实。`,
    '',
    '需修正的冲突：',
    list,
  ]
    .filter((l) => l !== '')
    .join('\n');
}
