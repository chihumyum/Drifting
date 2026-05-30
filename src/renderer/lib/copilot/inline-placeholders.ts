/**
 * inline-placeholders — model-generated example prompts shown in the
 * inline-edit input box, tailored to a project's genre. Two variants
 * (selection vs bare caret). Cached per project in settings, regenerated
 * lazily about once a week; built-in defaults cover the cold-start / failure
 * case so the box always has a sensible example.
 */
import loglevel from 'loglevel';
import { callStructured } from '../ai/call-structured';
import { inlineEditPlaceholdersPrompt } from '../ai/prompts/templates/inline-edit-placeholders';
import { resolveOutputLanguageName } from '../ai/output-language';
import { copilotRuntime } from './runtime';
import { useProjectStore } from '../../store/project-store';
import { useSettingsStore } from '../../store/settings-store';
import { parseKv } from '../../domain/kv';

const log = loglevel.getLogger('copilot:inline-placeholders');

export type PlaceholderVariant = 'selection' | 'block';

const REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // weekly

const DEFAULTS: Record<PlaceholderVariant, string[]> = {
  selection: [
    '帮我看看这几段有没有语病',
    '把这段改得更精炼一些',
    '换一种说法，别太直白',
    '强化这段的画面感和通感',
    '让这段对话的语气更冷一点',
  ],
  block: [
    '在这里补一句环境描写，增强紧张感',
    '给这段加一个贴切的比喻',
    '把这段的节奏收紧一点',
    '让这一段的情绪更克制',
    '顺一下这段的语序',
  ],
};

/** In-flight guard so concurrent opens don't fire duplicate generations. */
const inFlight = new Set<string>();

/** Cached examples for a project+variant, or built-in defaults. */
export function getInlinePlaceholders(
  projectId: string,
  variant: PlaceholderVariant,
): string[] {
  const cached = useSettingsStore.getState().copilotInlinePlaceholders[projectId];
  const list = cached?.[variant];
  return list && list.length > 0 ? list : DEFAULTS[variant];
}

/**
 * Ensure a project has fresh placeholders: regenerate if missing or older than
 * REFRESH_MS. Fire-and-forget — callers don't await; the next open picks up
 * the new cache. Safe to call on every popover open.
 */
export function ensureInlinePlaceholders(projectId: string): void {
  if (inFlight.has(projectId)) return;
  const cached = useSettingsStore.getState().copilotInlinePlaceholders[projectId];
  if (cached) {
    const age = Date.now() - new Date(cached.generatedAt).getTime();
    if (Number.isFinite(age) && age < REFRESH_MS) return;
  }
  inFlight.add(projectId);
  void generate(projectId).finally(() => inFlight.delete(projectId));
}

async function generate(projectId: string): Promise<void> {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project) return;
  const facts = parseKv(project.kvJson)
    .map((e) => `${e.key}: ${e.value}`)
    .filter((l) => l.trim().length > 2)
    .join('\n');

  try {
    const client = await copilotRuntime.getClient();
    const out = await callStructured(
      client,
      inlineEditPlaceholdersPrompt,
      { projectName: project.name, projectFacts: facts },
      { outputLanguage: resolveOutputLanguageName(projectId) },
    );
    const selection = out.selectionExamples.map((s) => s.trim()).filter(Boolean);
    const block = out.blockExamples.map((s) => s.trim()).filter(Boolean);
    if (selection.length === 0 && block.length === 0) return;
    useSettingsStore.getState().setCopilotInlinePlaceholders(projectId, {
      selection: selection.length ? selection : DEFAULTS.selection,
      block: block.length ? block : DEFAULTS.block,
      generatedAt: new Date().toISOString(),
    });
    log.info(`[inline-placeholders] generated for ${projectId.slice(0, 8)}`);
  } catch (err) {
    log.info('[inline-placeholders] generation failed, keeping defaults', err);
  }
}
