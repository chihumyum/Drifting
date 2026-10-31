import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

import { useSettingsStore } from '../../../store/settings-store';
import {
  agentOnboardingWaitsOnChange,
  buildAgentStarterPrompts,
  nextAgentOnboardingStep,
  noteAgentOnboarding,
  resolveAgentOnboardingView,
  type AgentOnboardingStep,
} from './agent-onboarding';

describe('Agent first-run steps', () => {
  it('moves new → change on the first send and change → done when the change is opened', () => {
    let step: AgentOnboardingStep = 'new';
    step = nextAgentOnboardingStep(step, { type: 'change-seen' });
    expect(step).toBe('new');
    step = nextAgentOnboardingStep(step, { type: 'sent' });
    expect(step).toBe('change');
    step = nextAgentOnboardingStep(step, { type: 'sent' });
    expect(step).toBe('change');
    step = nextAgentOnboardingStep(step, { type: 'change-seen' });
    expect(step).toBe('done');
    expect(nextAgentOnboardingStep(step, { type: 'sent' })).toBe('done');
    expect(nextAgentOnboardingStep(step, { type: 'change-seen' })).toBe('done');
  });

  it('writes the stored step only when an event moves it', () => {
    useSettingsStore.getState().setAgentOnboardingStep('done');
    const writes = vi.fn();
    const unsubscribe = useSettingsStore.subscribe(writes);
    noteAgentOnboarding({ type: 'sent' });
    noteAgentOnboarding({ type: 'change-seen' });
    expect(writes).not.toHaveBeenCalled();
    noteAgentOnboarding({ type: 'reset' });
    noteAgentOnboarding({ type: 'sent' });
    expect(useSettingsStore.getState().agentOnboardingStep).toBe('change');
    expect(writes).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('starts over from any step when Settings resets it', () => {
    for (const step of ['new', 'change', 'done'] as const) {
      expect(nextAgentOnboardingStep(step, { type: 'reset' })).toBe('new');
    }
  });
});

describe('what the empty conversation shows', () => {
  it('waits for the credential check', () => {
    expect(resolveAgentOnboardingView({ step: 'new', usable: null, emptyConversation: true })).toBeNull();
  });

  it('connects in place whenever no model can run, even after the guide is done', () => {
    for (const step of ['new', 'change', 'done'] as const) {
      expect(resolveAgentOnboardingView({ step, usable: false, emptyConversation: true })).toBe('connect');
    }
  });

  it('suggests requests only once, to a connected author who has not sent anything', () => {
    expect(resolveAgentOnboardingView({ step: 'new', usable: true, emptyConversation: true })).toBe('suggest');
    expect(resolveAgentOnboardingView({ step: 'change', usable: true, emptyConversation: true })).toBeNull();
    expect(resolveAgentOnboardingView({ step: 'done', usable: true, emptyConversation: true })).toBeNull();
  });

  it('never covers a conversation that has started', () => {
    for (const usable of [true, false]) {
      expect(resolveAgentOnboardingView({ step: 'new', usable, emptyConversation: false })).toBeNull();
    }
  });

  it('lets the change links wait only for the first turn that changed something', () => {
    expect(agentOnboardingWaitsOnChange('change', 1)).toBe(true);
    expect(agentOnboardingWaitsOnChange('change', 0)).toBe(false);
    expect(agentOnboardingWaitsOnChange('new', 2)).toBe(false);
    expect(agentOnboardingWaitsOnChange('done', 2)).toBe(false);
  });
});

describe('starter requests', () => {
  const chapters = [
    { id: 'c2', title: '第二章 北岬', bookOrder: 2, wordCount: 3000 },
    { id: 'c1', title: '第一章 潮声', bookOrder: 1, wordCount: 2400 },
    { id: 'c3', title: '第三章 退潮', bookOrder: 3, wordCount: 0 },
  ];
  const elements = [
    { id: 'e1', name: '北岬灯塔' },
    { id: 'e2', name: '林潮' },
    { id: 'e3', name: '老船长' },
  ];

  it('names the first written chapter and the two most linked elements', () => {
    const prompts = buildAgentStarterPrompts({ chapters, elements, relationCounts: { e2: 4, e3: 3, e1: 1 } });
    expect(prompts.map((prompt) => prompt.key)).toEqual(['commentChapter', 'tightenChapter', 'relateElements']);
    expect(prompts[0]).toMatchObject({ values: { chapter: '第一章 潮声' }, mark: { kind: 'chapter', seed: 'c1' } });
    expect(prompts[2]).toMatchObject({ values: { first: '林潮', second: '老船长' }, mark: { kind: 'element', seed: 'e2' } });
  });

  it('prefers the chapter opened most recently, skipping chapters with no words', () => {
    const prompts = buildAgentStarterPrompts({ chapters, elements, recentChapterIds: ['c3', 'c2', 'c1'] });
    expect(prompts[0].values.chapter).toBe('第二章 北岬');
  });

  it('keeps element order when no relation tells them apart', () => {
    const prompts = buildAgentStarterPrompts({ chapters, elements });
    expect(prompts[2].values).toEqual({ first: '北岬灯塔', second: '林潮' });
  });

  it('asks about one element, or extracts them from the chapter when there are none', () => {
    expect(buildAgentStarterPrompts({ chapters, elements: [elements[1]] })[2]).toMatchObject({
      key: 'completeElement',
      values: { element: '林潮' },
    });
    expect(buildAgentStarterPrompts({ chapters, elements: [] })[2]).toMatchObject({
      key: 'extractElements',
      values: { chapter: '第一章 潮声' },
    });
  });

  it('starts an empty book from nothing', () => {
    const prompts = buildAgentStarterPrompts({ chapters: [chapters[2]], elements });
    expect(prompts.map((prompt) => prompt.key)).toEqual(['outline', 'interview', 'castCharacters']);
    expect(prompts.every((prompt) => prompt.mark === null)).toBe(true);
  });
});
