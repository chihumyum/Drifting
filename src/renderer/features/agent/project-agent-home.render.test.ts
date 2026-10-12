import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(',')})` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

import {
  EMPTY_PROJECT_CHECKIN,
  useProjectCheckinStore,
  type StoredCheckinCard,
} from '../../store/project-checkin-store';
import { ProjectAgentHome, ProjectAgentHomeView } from './ProjectAgentHome';
import { ProjectMemoryEditor } from './ProjectMemoryEditor';

const root = resolve(import.meta.dirname, '../../../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

function card(patch: Partial<StoredCheckinCard> & Pick<StoredCheckinCard, 'id'>): StoredCheckinCard {
  return {
    title: `${patch.id} title`,
    detail: `${patch.id} detail`,
    instruction: `${patch.id} instruction`,
    target: null,
    createdAt: '2026-10-12T08:00:00.000Z',
    status: 'open',
    ...patch,
  };
}

function render(projectId = 'project-1') {
  // Server rendering reads zustand's initial snapshot, so feed the view the
  // seeded state directly; the container only adds the store subscription.
  const state = useProjectCheckinStore.getState();
  return renderToStaticMarkup(
    createElement(ProjectAgentHomeView, {
      projectId,
      openAgent: () => 'view',
      compact: false,
      record: state.projects[projectId] ?? EMPTY_PROJECT_CHECKIN,
      running: Boolean(state.running[projectId]),
      enabled: state.enabled,
      runNow: () => undefined,
    }),
  );
}

afterEach(() => {
  useProjectCheckinStore.setState({ enabled: true, projects: {}, running: {} });
});

describe('Project Home Agent entry rendering', () => {
  it('renders the composer and one hand-off action per card', () => {
    useProjectCheckinStore.setState({
      projects: {
        'project-1': {
          lastOpenedAt: null,
          lastCheckinAt: '2026-10-12T08:00:00.000Z',
          lastAttemptAt: null,
          error: null,
          cards: [
            card({ id: 'ask', target: { entityType: 'node', entityId: 'n', title: '第三章' } }),
            card({ id: 'work', detail: '' }),
            card({ id: 'started', status: 'started', conversationId: 'conv' }),
          ],
        },
      },
    });
    const html = render();
    expect(html).toContain('data-debug-id="project-agent-home"');
    expect(html).toContain('placeholder="projectAgent.placeholder"');
    expect(html).toContain('projectAgent.lastCheckin(');
    expect(html).toContain('「第三章」');
    expect(html).toContain('ask title');
    expect(html).not.toContain('work detail');
    // The card itself is the action; only a dismiss control sits beside it.
    expect(html.match(/class="pagent__card-open"/gu)).toHaveLength(3);
    expect(html.match(/title="projectAgent\.start"/gu)).toHaveLength(2);
    expect(html.match(/title="projectAgent\.openConversation"/gu)).toHaveLength(1);
    expect(html).toContain('projectAgent.started');
    expect(html.match(/aria-label="projectAgent\.dismiss"/gu)).toHaveLength(3);
    expect(html).not.toContain('pagent__btn');
  });

  it('shows progress, failure and first-run states without cards', () => {
    useProjectCheckinStore.setState({ running: { 'project-1': true } });
    expect(render()).toContain('projectAgent.checkinRunning');
    useProjectCheckinStore.setState({
      running: {},
      projects: {
        'project-1': {
          lastOpenedAt: null,
          lastCheckinAt: null,
          lastAttemptAt: null,
          error: 'offline',
          cards: [],
        },
      },
    });
    const failed = render();
    expect(failed).toContain('projectAgent.checkinFailed(offline)');
    expect(failed).toContain('projectAgent.checkinNever');
    useProjectCheckinStore.setState({ enabled: false });
    expect(render()).toContain('projectAgent.enable');
  });

  it('mounts through the store-backed container without starting a check-in', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectAgentHome, { projectId: 'p', projectName: 'n', openAgent: () => 'view' }),
    );
    expect(html).toContain('projectAgent.checkinNever');
  });

  it('renders an empty Project Memory editor with its append box', () => {
    const html = renderToStaticMarkup(createElement(ProjectMemoryEditor, { projectId: 'project-1' }));
    expect(html).toContain('projectMemory.desc');
    expect(html).toContain('projectMemory.empty');
    expect(html).toContain('placeholder="projectMemory.placeholder"');
  });

  it('has every rendered string in both locales', () => {
    const sources = [
      read('src/renderer/features/agent/ProjectAgentHome.tsx'),
      read('src/renderer/features/agent/ProjectMemoryEditor.tsx'),
    ].join('\n');
    const keys = new Set(
      [...sources.matchAll(/t\(\s*[`'](project(?:Agent|Memory)\.[\w.${}]+)[`']/gu)].map((match) => match[1]!),
    );
    for (const locale of ['zh-CN', 'en']) {
      const messages = JSON.parse(read(`src/renderer/locales/${locale}.json`)) as Record<string, unknown>;
      for (const key of keys) {
        if (key.includes('${')) continue;
        const value = key.split('.').reduce<unknown>(
          (node, part) => (node as Record<string, unknown> | undefined)?.[part],
          messages,
        );
        expect(typeof value, `${locale}: ${key}`).toBe('string');
      }
    }
  });
});
