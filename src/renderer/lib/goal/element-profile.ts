/**
 * /goal 一键演化 — render an element's full current content as compact text, so
 * the editor fan-out carries it in-context instead of burning a read_element
 * tool-call per chapter (GOAL-EVOLVE.md §1 follow-up). Same element across the
 * whole fan-out → render once, reuse.
 *
 * Reads the data-store cache (optimistic-updated on the author's edit), which is
 * current enough for grounding context.
 */
import { useDataStore } from '../../store/data-store';
import { docToPlainText } from '../agent/serialize';
import { parseKv } from '../../domain/kv';

export function renderElementProfile(projectId: string, elementId: string): string {
  const el = useDataStore
    .getState()
    .bookElements.find((e) => e.id === elementId && e.projectId === projectId);
  if (!el) return '';
  const lines: string[] = [`名称：${el.name}`];
  if (el.aliases.length) lines.push(`别名：${el.aliases.join('、')}`);
  if (el.summary?.trim()) lines.push(`简介：${el.summary.trim()}`);
  const facts = parseKv(el.kvJson).filter((kv) => kv.key.trim() || kv.value.trim());
  if (facts.length) lines.push(`字段：\n${facts.map((kv) => `  - ${kv.key}：${kv.value}`).join('\n')}`);
  const body = docToPlainText(el.contentJson).trim();
  if (body) lines.push(`正文设定：\n${body}`);
  return lines.join('\n');
}
