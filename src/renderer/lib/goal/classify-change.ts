/**
 * /goal 一键演化 — the SEMANTIC gate (GOAL-EVOLVE.md §3).
 *
 * A cheap one-shot classification of the change itself (just the old→new diff),
 * run BEFORE scoping. Element-agnostic (character / place / object / rule / …):
 * 'essence' changes (a thing's fundamental nature/feel) are the critic's blind
 * spot — the orchestrator declines them (force overrides). Reuses the renderer AI
 * substrate (DeepSeek by default), same as compileRule.
 */
import { buildDefaultLLMClient } from '../ai/client/build-default-client';
import { callStructured } from '../ai/call-structured';
import { resolveWritingLanguage } from '../ai/output-language';
import { goalChangeClassifyPrompt } from '../ai/prompts/templates/goal-change-classify';
import type { ElementChange, ChangeClass } from './types';

export async function classifyChange(
  projectId: string,
  change: ElementChange,
  signal?: AbortSignal,
): Promise<ChangeClass> {
  const client = await buildDefaultLLMClient();
  return callStructured(
    client,
    goalChangeClassifyPrompt,
    {
      elementName: change.elementName,
      field: change.field,
      oldSetting: change.oldSetting,
      newSetting: change.newSetting,
    },
    { outputLanguage: resolveWritingLanguage(projectId), signal },
  );
}
