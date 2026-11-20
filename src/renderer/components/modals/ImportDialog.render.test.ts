import { createElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let mockStorylines: { id: string; name: string; color?: string }[] = [];

vi.mock('react-router-dom', () => ({
  useParams: () => ({ projectId: 'proj-1' }),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(',')})` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('../../store/auth', () => ({
  useAuthStore: (selector: (s: { user: { id: string } | null }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}));

vi.mock('../../store/data-store', () => ({
  useDataStore: (
    selector: (s: {
      storylines: typeof mockStorylines;
      bookElementCategories: { id: string; name: string; color?: string }[];
      bookNodes: unknown[];
    }) => unknown,
  ) =>
    selector({
      storylines: mockStorylines,
      bookElementCategories: [],
      bookNodes: [],
    }),
}));

vi.mock('../../usecase/useBookNode', () => ({
  useBookNode: () => ({ createNode: vi.fn() }),
}));

vi.mock('../../usecase/useBookElement', () => ({
  useBookElement: () => ({ createElement: vi.fn() }),
}));

vi.mock('../ui/Modal', () => ({
  ModalRoot: ({ children }: { children: ReactNode }) => createElement('div', { role: 'dialog' }, children),
  ModalCard: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  ModalHeader: ({ title }: { title: ReactNode }) => createElement('header', null, title),
  ModalBody: ({ children }: { children: ReactNode }) => createElement('section', null, children),
  ModalActions: ({ children }: { children: ReactNode }) => createElement('footer', null, children),
}));

const { ImportDialog } = await import('./ImportDialog');

describe('ImportDialog without storylines', () => {
  it('shows non-blocking helper text instead of a warning when the project has no storylines', () => {
    mockStorylines = [];
    const html = renderToStaticMarkup(createElement(ImportDialog, { open: true, onClose: () => {} }));
    expect(html).toContain('class="import-dialog__desc">importDialog.noStorylines<');
    expect(html).not.toContain('import-dialog__warning');
  });

  it('renders the storyline selector when storylines exist', () => {
    mockStorylines = [{ id: 'sl-1', name: 'Main Line', color: '#4488aa' }];
    const html = renderToStaticMarkup(createElement(ImportDialog, { open: true, onClose: () => {} }));
    expect(html).toContain('Main Line');
    expect(html).not.toContain('importDialog.noStorylines');
  });

  it('does not block chapter commits on missing storylines and passes resolvedStorylineId', () => {
    const source = readFileSync(new URL('./ImportDialog.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain("throw new Error('Storyline required')");
    expect(source).toContain('mainStorylineId: resolvedStorylineId');
    expect(source).toContain('UNAFFILIATED_STORYLINE_OPTION');
  });
});
