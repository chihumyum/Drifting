/**
 * /goal 一键演化 — the element-scoped CRITIC (GOAL-EVOLVE.md §4).
 *
 * This module OWNS the forked criterion (policy + assertion); the FC loop /
 * effective-canon substrate is reused from tool-handlers via runEvolveCriticBatch.
 * The criterion is contradiction-anchored, NOT "is it sufficiently reflected" —
 * an open-ended "reflect it more" check has no fixed point and the loop would
 * never converge. So: only report prose that DIRECTLY contradicts the new value.
 */
import { runEvolveCriticBatch, type AgentToolContext } from '../agent/tool-handlers';
import type { ElementChange, ContradictionSpot } from './types';

/** Judging policy injected as `judgingGuide` — REPLACES the project rule sweep. */
export const EVOLVE_CRITIC_POLICY = [
  '【一键演化·审阅政策】你不在跑常规规则审阅。你只审一件事：本章正文是否与某个设定的【新值】直接矛盾。',
  '· 只报「正文与新设定直接冲突」的段落（例：设定改为「失明」，正文却写他看见 / 读到 / 与人对视）。',
  '· 不要因为「这段没有充分体现新设定」就报——遗漏不是矛盾。只有可证伪的【直接冲突】才报。',
  '· 安全检查：若某段与该设定【对本章已生效】的演化记录(patch)一致，则不算冲突。',
  '· 该设定的当前完整内容、以及对本章已生效的演化记录(patch)，已在背景中给出——直接据此核对，无需再调用 read_element / get_element_patches。',
  '· 不裁定别的设定、别的角色、文风、字数——超出本设定改动的一律不报。',
  '· 每条都在 basis 写明：核对了新设定的哪一点 vs 本章哪几段 → 冲突还是一致。',
].join('\n');

/** The single assertion the critic rules on, built from the element change. */
export function buildEvolveAssertion(change: ElementChange): string {
  const field = change.field ? `（${change.field}）` : '';
  return [
    `本章正文须与设定《${change.elementName}》${field}的【新值】一致，不得与之直接矛盾。`,
    `新值：${change.newSetting}`,
    change.oldSetting
      ? `（旧值：${change.oldSetting}——正文若仍停留在旧值且与新值冲突，即为需修正的矛盾）`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Critique one chapter for contradictions with the element's NEW setting. Returns
 * the contradiction spots — the editor leaf's work-list, and the strict-shrink set.
 */
export async function critiqueChapter(
  ctx: AgentToolContext,
  chapterId: string,
  chapterTitle: string,
  change: ElementChange,
  signal?: AbortSignal,
): Promise<ContradictionSpot[]> {
  const assertion = buildEvolveAssertion(change);
  const [violations = []] = await runEvolveCriticBatch(
    ctx,
    chapterId,
    [assertion],
    EVOLVE_CRITIC_POLICY,
    change.elementId, // pre-load this element's profile + effective patches
    signal,
  );
  return violations.map((v) => ({
    chapterId,
    chapterTitle,
    blockIds: v.blockIds,
    reason: v.reason,
    confidence: v.confidence,
  }));
}
