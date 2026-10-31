/**
 * The Agent panel's first run (docs/agent-runtime/agent-onboarding.md).
 *
 * The empty conversation is the guide. While no model can run it holds the
 * provider rows, connected in place; once one can, it offers three requests
 * that fit the open book; after the first turn that changes something, the
 * change link waits for the author once. Pure decisions live here so the
 * panel, the settings reset and the tests read one state machine.
 */
import type { BYOKProvider } from '../../../lib/byok-keychain';
import type { KindMarkKind } from '../../../components/ui/kind-mark';
import { useSettingsStore, type AgentOnboardingStep } from '../../../store/settings-store';

export type { AgentOnboardingStep };

export type AgentOnboardingEvent =
  | { type: 'sent' }
  | { type: 'change-seen' }
  | { type: 'reset' };

export function nextAgentOnboardingStep(
  step: AgentOnboardingStep,
  event: AgentOnboardingEvent,
): AgentOnboardingStep {
  switch (event.type) {
    case 'sent':
      return step === 'new' ? 'change' : step;
    case 'change-seen':
      return step === 'change' ? 'done' : step;
    case 'reset':
      return 'new';
  }
}

/** Advance the stored step; settings are written only when it moves. */
export function noteAgentOnboarding(event: AgentOnboardingEvent): void {
  const settings = useSettingsStore.getState();
  const next = nextAgentOnboardingStep(settings.agentOnboardingStep, event);
  if (next !== settings.agentOnboardingStep) settings.setAgentOnboardingStep(next);
}

/** What the empty conversation shows. */
export type AgentOnboardingView = 'connect' | 'suggest' | null;

export function resolveAgentOnboardingView(input: {
  step: AgentOnboardingStep;
  /** null while the credential check has not answered. */
  usable: boolean | null;
  /** No messages and nothing starting or running in the shown conversation. */
  emptyConversation: boolean;
}): AgentOnboardingView {
  if (!input.emptyConversation || input.usable === null) return null;
  // Connecting is how the panel works at all, so it is never "seen".
  if (!input.usable) return 'connect';
  return input.step === 'new' ? 'suggest' : null;
}

/** Whether the turn's change links wait for the author (once). */
export function agentOnboardingWaitsOnChange(step: AgentOnboardingStep, changedEntities: number): boolean {
  return step === 'change' && changedEntities > 0;
}

/** Where each provider hands out keys, opened outside Drifting. */
export const AGENT_PROVIDER_KEY_PAGES: Record<BYOKProvider, string> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};

export type AgentStarterPromptKey =
  | 'commentChapter'
  | 'tightenChapter'
  | 'relateElements'
  | 'completeElement'
  | 'extractElements'
  | 'outline'
  | 'interview'
  | 'castCharacters';

export interface AgentStarterPrompt {
  /** The locale key under `agentPanel.onboarding.prompts`. */
  key: AgentStarterPromptKey;
  values: Record<string, string>;
  mark: { kind: KindMarkKind; seed: string } | null;
}

export interface AgentStarterPromptSource {
  chapters: ReadonlyArray<{ id: string; title: string; bookOrder: number; wordCount: number }>;
  /** Oldest first: authors usually create the main characters first. */
  elements: ReadonlyArray<{ id: string; name: string }>;
  /** Links to other elements per element id; more first, ties keep `elements` order. */
  relationCounts?: Readonly<Record<string, number>>;
  /** Chapter ids, most recently opened first. */
  recentChapterIds?: readonly string[];
}

/**
 * Three requests that fit the open book: a chapter the author has written in
 * (the most recently opened one, else the first), and the two elements most
 * linked to other elements. One of them is a small edit, so the first turn
 * usually shows what an Agent change looks like.
 */
export function buildAgentStarterPrompts(source: AgentStarterPromptSource): AgentStarterPrompt[] {
  const written = source.chapters.filter((chapter) => chapter.wordCount > 0 && chapter.title.trim());
  const byId = new Map(written.map((chapter) => [chapter.id, chapter]));
  const recent = source.recentChapterIds?.map((id) => byId.get(id)).find(Boolean);
  const chapter = recent ?? [...written].sort((a, b) => a.bookOrder - b.bookOrder)[0];
  const counts = source.relationCounts ?? {};
  const elements = source.elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => element.name.trim())
    .sort((a, b) => (counts[b.element.id] ?? 0) - (counts[a.element.id] ?? 0) || a.index - b.index)
    .map(({ element }) => element);

  if (!chapter) {
    return [
      { key: 'outline', values: {}, mark: null },
      { key: 'interview', values: {}, mark: null },
      { key: 'castCharacters', values: {}, mark: null },
    ];
  }
  const chapterMark = { kind: 'chapter' as const, seed: chapter.id };
  const prompts: AgentStarterPrompt[] = [
    { key: 'commentChapter', values: { chapter: chapter.title }, mark: chapterMark },
    { key: 'tightenChapter', values: { chapter: chapter.title }, mark: chapterMark },
  ];
  const [first, second] = elements;
  if (first && second) {
    prompts.push({
      key: 'relateElements',
      values: { first: first.name, second: second.name },
      mark: { kind: 'element', seed: first.id },
    });
  } else if (first) {
    prompts.push({ key: 'completeElement', values: { element: first.name }, mark: { kind: 'element', seed: first.id } });
  } else {
    prompts.push({ key: 'extractElements', values: { chapter: chapter.title }, mark: chapterMark });
  }
  return prompts;
}
