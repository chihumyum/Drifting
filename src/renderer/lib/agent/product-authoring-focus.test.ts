import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BookElement, BookElementCategory } from '../../domain/book-element';
import type { BookNode } from '../../domain/book-node';
import { useDataStore } from '../../store/data-store';
import { useUiStore } from '../../store/ui-store';
import {
  buildProductAgentWritingContext,
  getActiveAgentAuthoringFocus,
} from './product-authoring-focus';

const PROJECT_ID = 'authoring-focus-project';
const originalData = useDataStore.getState();
const originalTabs = useUiStore.getState().tabsByProject;

const chapter: BookNode = {
  id: 'chapter-focus',
  projectId: PROJECT_ID,
  kind: 'chapter',
  title: '雨夜/归来',
  summary: '',
  bookOrder: 0,
  narrativeOrder: null,
  driftGroupId: null,
  writingStatus: 'draft',
  position: { x: 0, y: 0 },
  wordCount: 0,
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};

const category: BookElementCategory = {
  id: 'category-focus',
  projectId: PROJECT_ID,
  name: '势力与组织',
  contentJson: '{}',
  elementTemplateJson: '{}',
  elementTemplateKvJson: '[]',
  color: '#777777',
  layoutMode: 'auto',
  gridX: null,
  gridY: null,
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};

const element: BookElement = {
  id: 'element-focus',
  projectId: PROJECT_ID,
  categoryId: category.id,
  name: '留存者议会',
  summary: '',
  contentJson: '{}',
  kvJson: '[]',
  aliases: ['议会'],
  groupName: null,
  portraitAssetId: null,
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};

beforeEach(() => {
  useDataStore.setState({
    bookNodes: [chapter],
    bookElements: [element],
    bookElementCategories: [category],
    storylines: [],
  });
  useUiStore.setState({
    tabsByProject: {
      [PROJECT_ID]: {
        openTabs: [
          {
            kind: 'leaf',
            entityType: 'node',
            id: chapter.id,
            isPreview: false,
          },
        ],
        activeTabKey: `node:${chapter.id}`,
      },
    },
  });
});

afterEach(() => {
  useDataStore.setState({
    bookNodes: originalData.bookNodes,
    bookElements: originalData.bookElements,
    bookElementCategories: originalData.bookElementCategories,
    storylines: originalData.storylines,
  });
  useUiStore.setState({ tabsByProject: originalTabs });
});

describe('product authoring focus', () => {
  it('resolves the focused pane to its encoded canonical prose path', () => {
    expect(getActiveAgentAuthoringFocus(PROJECT_ID)).toMatchObject({
      projectId: PROJECT_ID,
      entity: {
        kind: 'chapter',
        id: chapter.id,
        name: chapter.title,
        path: '/chapters/雨夜%2F归来/prose.md',
      },
      mode: 'entity',
    });
  });

  it('includes named canon entities in product-owned impact analysis', () => {
    const context = buildProductAgentWritingContext(
      PROJECT_ID,
      '修改设定：让留存者议会推翻旧誓约。',
    );
    expect(context.canonImpact).toMatchObject({
      level: 'high',
      referencedTerms: ['留存者议会'],
      requiresSanctionedPatch: true,
    });
  });

  it('resolves current names and aliases into canonical explicit prose targets', () => {
    const elementContext = buildProductAgentWritingContext(PROJECT_ID, '重写议会的人物设定正文。');
    expect(elementContext).toMatchObject({
      intent: { scopeKind: 'explicit', clarificationRequired: false },
      resolvedTargets: [
        {
          kind: 'element',
          id: element.id,
          name: element.name,
          path: '/elements/势力与组织/留存者议会/body.md',
        },
      ],
    });

    const chapterContext = buildProductAgentWritingContext(PROJECT_ID, '重写《雨夜/归来》的开场。');
    expect(chapterContext.resolvedTargets).toEqual([
      expect.objectContaining({
        kind: 'chapter',
        id: chapter.id,
        path: '/chapters/雨夜%2F归来/prose.md',
      }),
    ]);
  });
});
