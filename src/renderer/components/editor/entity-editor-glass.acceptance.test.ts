import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { designSystemDocs } from '../design-system-docs.test-support';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

const shell = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../platform/runtime', () => ({
  getPlatformRuntime: () => ({ isMobileShell: shell.mobile }),
}));

import { KvEditor } from './KvEditor';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

/** Every rule whose selector names one of `classes` (whole class names), as [selector, body]. */
function rules(css: string, classes: string[]): Array<[string, string]> {
  const named = classes.map((name) => new RegExp(`${name.replace(/[.-]/g, '\\$&')}(?![\\w-])`));
  const found: Array<[string, string]> = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (named.some((name) => name.test(selector))) found.push([selector, match[2]]);
  }
  return found;
}

const kv = JSON.stringify([
  { key: '性别', value: '男' },
  { key: '出身', value: '北境渔村' },
]);

describe('entity editors in sand and glass', () => {
  it('writes each field on desktop in a slip of resting glass and keeps mobile outlined', () => {
    shell.mobile = false;
    const desktop = renderToStaticMarkup(createElement(KvEditor, { valueJson: kv, onPersist: () => {} }));
    expect(desktop).toContain('class="kv-editor kv-editor--glass"');
    expect(desktop).toContain('class="kv-editor__row glass glass--rest glass--field"');

    const readOnly = renderToStaticMarkup(
      createElement(KvEditor, { valueJson: kv, onPersist: () => {}, readOnly: true }),
    );
    expect(readOnly).toContain('class="kv-editor__row glass glass--rest glass--still"');

    shell.mobile = true;
    const mobile = renderToStaticMarkup(createElement(KvEditor, { valueJson: kv, onPersist: () => {} }));
    expect(mobile).toContain('class="kv-editor"');
    expect(mobile).not.toContain('glass');
    shell.mobile = false;
  });

  it('gives the paused mobile shell its own look in every entity editor', () => {
    for (const path of [
      'src/renderer/views/ElementEditorView.tsx',
      'src/renderer/views/CategoryEditorView.tsx',
      'src/renderer/views/StorylineEditorView.tsx',
      'src/renderer/views/NodeEditorView.tsx',
      'src/renderer/components/editor/ReferencesPanel.tsx',
      'src/renderer/components/editor/PatchEditorCard.tsx',
      'src/renderer/components/editor/PatchesSection.tsx',
      'src/renderer/components/editor/KvEditor.tsx',
      'src/renderer/components/editor/FieldReview.tsx',
    ]) {
      expect(source(path), path).toContain('getPlatformRuntime().isMobileShell');
    }
  });

  it('trades the colour slab for the large sand mark and the swatches for round glass', () => {
    for (const [path, kind] of [
      ['src/renderer/views/StorylineEditorView.tsx', 'storyline'],
      ['src/renderer/views/CategoryEditorView.tsx', 'category'],
    ] as const) {
      const view = source(path);
      expect(view).toMatch(/\{!glass && \(\s*<div\s+className="elem-portrait/);
      expect(view).toContain(`<KindMark kind="${kind}" color=`);
      expect(view).toContain('className="entity-hero__mark"');
      expect(view).toContain('className="col-pick__dot glass glass--round"');
      expect(view).toContain('<i className="sand sand--blob-2"');
    }

    const element = source('src/renderer/views/ElementEditorView.tsx');
    expect(element).toContain('<span className="entity-alias sand-cell">');
    expect(element).toContain('<i className="cell-ring" aria-hidden="true" />');
  });

  it('lists chapters and elements as sidebar cells under a GlassSlider', () => {
    for (const path of ['src/renderer/views/StorylineEditorView.tsx', 'src/renderer/views/CategoryEditorView.tsx']) {
      const view = source(path);
      expect(view).toMatch(/<GlassSlider\s+className="entity-slider"/);
      expect(view).toContain("className={`mgr-row${glass ? ' mgr-row--glass sand-cell' : ''}`}");
      expect(view).toContain('{glass && <i className="cell-ring" aria-hidden="true" />}');
    }
    expect(source('src/renderer/views/StorylineEditorView.tsx')).toMatch(
      /kind="chapter"\s+seed=\{n\.id\}\s+hollow=\{exactWords != null && !hasContent\}/,
    );
    expect(source('src/renderer/views/CategoryEditorView.tsx')).toContain(
      '<KindMark kind="element" hollow={!hasContent}',
    );
  });

  it('cards relations, opens the picker in place and keeps mention rows flat', () => {
    const panel = source('src/renderer/components/editor/ReferencesPanel.tsx');
    expect(panel).toContain("' refs-rel-card--glass glass glass--rest glass--surface'");
    expect(panel).toMatch(/\{!glass && \(\s*<button[\s\S]*?refs-rel-card--add/);
    expect(panel).toContain('<label className="ui-field glass glass--rest glass--field">');
    expect(panel).toContain('<Button variant="primary" size="sm" disabled={!pendingTypeId}');
    expect(panel).toMatch(/<GlassSlider\s+className="entity-slider"/);
    expect(panel).toContain("refs-cards${glass ? ' refs-cards--plain' : ''}");
  });

  it('cards each patch, says invalid in ink and sweeps in the Agent’s patch', () => {
    const card = source('src/renderer/components/editor/PatchEditorCard.tsx');
    expect(card).toContain("' patch-card--glass glass glass--rest glass--surface'");
    expect(card).toContain("' patch-card--agent-delete' : ' patch-card--agent-add'} glass-sweep");
    expect(card).toContain('<BrushIcon name="status-warning" size={11} />');
    expect(card).toContain("glass ? ' glass glass--rest glass--still' : ''");
    expect(card).toContain("(glass ? ' menu-surface__item' : '')");

    const review = source('src/renderer/components/editor/FieldReview.tsx');
    expect(review).toContain("glass && arrived ? 'glass-sweep' : ''");
  });

  it('chooses in dialogs from menu rows and drift conversions from cards of glass', () => {
    const element = source('src/renderer/views/ElementEditorView.tsx');
    expect(element).toContain('<label className="ui-field glass glass--rest glass--field">');
    expect(element).toContain('menu-surface__item entity-choice__row');
    const node = source('src/renderer/views/NodeEditorView.tsx');
    expect(node).toContain('className="entity-choice-grid"');
    expect(node).toContain("className={`entity-choice-card glass glass--rest${pickedId === opt.id ? ' is-on' : ''}`}");
    expect(node).toContain('menu-surface__item entity-choice__row');
  });

  it('draws the desktop rules with no wash, shadow or side bar', () => {
    const css = source('src/styles/entity-editors.css');
    const desktop = rules(css, [
      '.refs-section__text-action',
      '.refs-rel-card--glass',
      '.refs-cards--plain',
      '.refs-picker--glass',
      '.patch-card--glass',
      '.mgr-toolbar--glass',
      '.mgr-list--glass',
      '.mgr-row--glass',
      '.kv-editor--glass',
      '.field-review--glass',
      '.entity-hero__name-row',
      '.entity-hero__mark',
      '.entity-aliases',
      '.entity-alias',
      '.entity-alias__remove',
      '.entity-choice',
      '.entity-choice__row',
      '.entity-choice-grid',
      '.entity-choice-card',
      '.entity-slider',
      '.col-pick--glass',
      '.col-pick__dot',
      '.mgr-row__mark',
      '.refs-picker__type',
      '.patch-card__invalid',
      '.patch-card__agent-tag',
    ]);
    expect(desktop.length).toBeGreaterThan(40);
    for (const [selector, body] of desktop) {
      expect(body, selector).not.toMatch(/box-shadow/);
      for (const value of body.matchAll(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/g)) {
        expect(value[1].trim(), selector).toBe('transparent');
      }
    }
    expect(css).toMatch(/\.mgr-row--glass::before \{\s*content: none;/);
    expect(css).not.toContain('.mgr-add');
    expect(css).not.toContain('.mgr-toolbar__btn');
  });

  it('writes every desktop folio as the mark beside its name in ink', () => {
    const node = source('src/renderer/views/NodeEditorView.tsx');
    expect(node).toContain("t('nodeEditor.folio.chapterNumber', { n: chapterNumber })");
    expect(node).toMatch(/page__folio-storyline">\s*<KindMark kind="storyline" color=\{storylineColor\} \/>/);
    expect(node).toMatch(/page__folio-storyline">\s*<KindMark kind="drift-group" \/>/);
    for (const [path, kind] of [
      ['src/renderer/views/ElementEditorView.tsx', 'category'],
      ['src/renderer/views/StorylineEditorView.tsx', 'storyline'],
      ['src/renderer/views/CategoryEditorView.tsx', 'category'],
    ] as const) {
      expect(source(path), path).toMatch(
        new RegExp(`page__folio-storyline">\\s*<KindMark kind="${kind}"`),
      );
    }
  });

  it('documents the entity editors in the component catalogue', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('## 实体编辑器');
    expect(docs).toContain('`entity-editor-glass.acceptance.test.ts`');
  });
});
