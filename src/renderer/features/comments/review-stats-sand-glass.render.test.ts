import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

import { createPlainCommentDoc, type Comment } from '../../domain/comment';
import { getPlatformRuntime } from '../../platform/runtime';
import { useDataStore } from '../../store/data-store';
import { WorkspaceNavigationProvider } from '../workspace/navigation/WorkspaceNavigationContext';
import type { WorkspaceNavigator } from '../workspace/navigation/workspace-target';
import { CommentBodyEditor } from './CommentBodyEditor';
import { ReviewItemCard } from './ReviewItemCard';
import { TodoStatusToggle } from './TodoStatusToggle';
import { reviewTargetColor } from './review-groups';
import {
  Notes,
  ProgressBar,
  SnapshotEntryButton,
  StackedBar,
  StatsLinkRow,
  StatsMark,
  StatsSection,
} from '../stats/StatsPrimitives';

const runtime = getPlatformRuntime();
const onMobile = (render: () => string) => {
  runtime.isMobileShell = true;
  try {
    return render();
  } finally {
    runtime.isMobileShell = false;
  }
};
afterEach(() => {
  runtime.isMobileShell = false;
});

const navigator: WorkspaceNavigator = {
  projectId: 'p1',
  open: () => {},
  activate: () => {},
  showProjectHome: () => {},
  leaveDeletedTarget: () => {},
};
const inShell = (node: ReactElement) =>
  renderToStaticMarkup(createElement(WorkspaceNavigationProvider, { navigator, children: node }));

const now = '2026-10-29T00:00:00.000Z';
const todo = (status: Comment['status']): Comment => ({
  id: `todo-${status}`,
  projectId: 'p1',
  kind: 'todo',
  targetKind: 'node',
  targetId: 'n1',
  targetBlockId: null,
  anchorJson: '{}',
  authorKind: 'user',
  authorId: 'local',
  authorName: null,
  bodyJson: createPlainCommentDoc('补一句雨停的时间'),
  status,
  priority: null,
  source: 'manual',
  metadataJson: null,
  targetBlockIdsJson: '[]',
  resolvedAt: status === 'resolved' ? now : null,
  createdAt: now,
  updatedAt: now,
});

describe('Review cards in sand and glass', () => {
  it('lays no plate on the desktop card: only the resting glass line', () => {
    const card = inShell(createElement(ReviewItemCard, { comment: todo('open'), projectId: 'p1', presentation: 'panel' }));
    expect(card).toContain('review-card--glass glass glass--rest glass--surface');
    expect(card).not.toContain('workspace-list-row');

    const sticky = inShell(createElement(ReviewItemCard, { comment: todo('open'), projectId: 'p1', presentation: 'sticky' }));
    expect(sticky).toContain('review-card review-card--sticky review-card--todo review-card--glass glass glass--rest glass--surface');
  });

  it('keeps the mobile card on its plate', () => {
    const card = onMobile(() => inShell(createElement(ReviewItemCard, { comment: todo('open'), projectId: 'p1', presentation: 'panel' })));
    expect(card).toContain('workspace-list-row glass glass--surface');
    expect(card).not.toContain('review-card--glass');
  });

  it('makes done a round glass button with the brush tick inside', () => {
    const open = renderToStaticMarkup(createElement(TodoStatusToggle, { resolved: false, onToggle: () => {} }));
    expect(open).toContain('class="todo-status-toggle todo-status-toggle--glass glass glass--round glass--rest"');
    expect(open).toContain('aria-pressed="false"');
    expect(open).toContain('brush-icon--check');
    expect(open).not.toContain('todo-status-toggle__ring');

    const done = renderToStaticMarkup(createElement(TodoStatusToggle, { resolved: true, onToggle: () => {} }));
    expect(done).toContain('aria-pressed="true"');

    const mobile = onMobile(() => renderToStaticMarkup(createElement(TodoStatusToggle, { resolved: true, onToggle: () => {} })));
    expect(mobile).toContain('todo-status-toggle__ring');
    expect(mobile).not.toContain('glass');
  });

  it('edits on the composer\'s slip with a text button to cancel and the primary glass to save', () => {
    const editor = renderToStaticMarkup(createElement(CommentBodyEditor, { text: '原文', onSave: async () => {}, onClose: () => {} }));
    expect(editor).toContain('class="review-card__slip glass glass--rest glass--field"');
    expect(editor).toContain('class="review-card__action"');
    expect(editor).toContain('class="review-card__action glass glass--primary"');
    expect(editor).not.toContain('ui-button');

    const mobile = onMobile(() => renderToStaticMarkup(createElement(CommentBodyEditor, { text: '原文', onSave: async () => {}, onClose: () => {} })));
    expect(mobile).toContain('ui-button');
    expect(mobile).not.toContain('review-card__slip');
  });

  it('paints a group or source mark in its thing\'s own colour', () => {
    useDataStore.setState({
      storylines: [{ id: 's1', color: '#3c6fb0' }],
      bookElementCategories: [{ id: 'c1', color: '#8a6fa8' }],
      bookElements: [{ id: 'e1', categoryId: 'c1' }],
    } as never);
    const data = useDataStore.getState();
    expect(reviewTargetColor(data, { n1: 's1' }, 'node', 'n1')).toBe('#3c6fb0');
    expect(reviewTargetColor(data, {}, 'node', 'n2')).toBe('hsl(var(--ink-4))');
    expect(reviewTargetColor(data, {}, 'element', 'e1')).toBe('#8a6fa8');
    expect(reviewTargetColor(data, {}, 'storyline', 's1')).toBe('#3c6fb0');
    expect(reviewTargetColor(data, {}, 'library_item', 'm1')).toBe('hsl(var(--ink-4))');
  });
});

describe('the stats panel in sand and glass', () => {
  it('reads a value as a dry sand stroke over loose grains', () => {
    const bar = renderToStaticMarkup(createElement(ProgressBar, { pct: 76, color: '#3c6fb0' }));
    expect(bar).toContain('class="sand-track"');
    expect(bar).toContain('class="sand-stroke"');
    expect(bar).toContain('width:76%');
    expect(bar).toContain('--sand-c:#3c6fb0');
    expect(bar).not.toContain('accent');
  });

  it('tells completion by how much sand each stroke holds, in ink', () => {
    const bar = renderToStaticMarkup(createElement(StackedBar, {
      segments: [
        { key: 'done', pct: 50, color: 'hsl(var(--accent))', sandColor: 'hsl(var(--ink-2))' },
        { key: 'draft', pct: 30, color: 'hsl(var(--accent))', sandColor: 'hsl(var(--ink-2))', density: 'dry' },
        { key: 'todo', pct: 20, color: 'hsl(var(--accent))', sandColor: 'hsl(var(--ink-2))', density: 'loose' },
      ],
    }));
    expect(bar).toContain('class="stats-strokes"');
    expect(bar).toContain('class="sand-stroke sand-stroke--dry"');
    expect(bar).toContain('class="sand-stroke sand-stroke--loose"');
    expect(bar).not.toContain('accent');
  });

  it('names things by their sand mark and opens them through the cell ring', () => {
    const row = renderToStaticMarkup(createElement(StatsLinkRow, {
      name: '林晚', color: '#8a6fa8', mark: 'element', meta: '×12', onOpen: () => {},
    }));
    expect(row).toContain('class="stats-link sand-cell"');
    expect(row).toContain('<i class="cell-ring" aria-hidden="true"></i>');
    expect(row).toContain('kind-mark kind-mark--element');
    expect(row).toContain('--cell-c:#8a6fa8');
    expect(row).toMatch(/^<button type="button"/);

    expect(renderToStaticMarkup(createElement(StatsMark, { kind: 'storyline', color: '#3c6fb0' }))).toContain('kind-mark--storyline');
  });

  it('keeps titles, notes and the history entry flat or resting glass', () => {
    const section = renderToStaticMarkup(createElement(StatsSection, { title: '分幕节奏', topBorder: true, children: 'x' }));
    expect(section).toContain('class="stats-section stats-section--after"');
    expect(section).not.toContain('border');
    expect(renderToStaticMarkup(createElement(Notes, { children: '正文尚未 @ 提及任何要素。' }))).toContain('class="stats-note"');
    expect(renderToStaticMarkup(createElement(SnapshotEntryButton, { entityKind: 'node', entityId: 'n1' })))
      .toContain('class="stats-snapshot glass glass--rest"');
  });

  it('leaves the paused mobile shell its inline fallback', () => {
    const mobile = onMobile(() => [
      renderToStaticMarkup(createElement(ProgressBar, { pct: 40 })),
      renderToStaticMarkup(createElement(StatsLinkRow, { name: '林晚', color: '#8a6fa8', mark: 'element', onOpen: () => {} })),
      renderToStaticMarkup(createElement(StackedBar, { segments: [{ key: 'a', pct: 100, color: '#3c6fb0', opacity: 0.5 }] })),
    ].join(''));
    expect(mobile).not.toContain('sand-stroke');
    expect(mobile).not.toContain('kind-mark');
    expect(mobile).toContain('role="button"');
    expect(mobile).toContain('background:hsl(var(--accent))');
    expect(mobile).toContain('opacity:0.5');
  });
});
