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
  it('writes each field in a slip of resting glass on every shell', () => {
    const editable = renderToStaticMarkup(createElement(KvEditor, { valueJson: kv, onPersist: () => {} }));
    expect(editable).toContain('class="kv-editor kv-editor--glass"');
    expect(editable).toContain('class="kv-editor__row glass glass--rest glass--field"');

    const readOnly = renderToStaticMarkup(
      createElement(KvEditor, { valueJson: kv, onPersist: () => {}, readOnly: true }),
    );
    expect(readOnly).toContain('class="kv-editor__row glass glass--rest glass--still"');

    // No outlined fallback is left to switch to.
    const kvSource = source('src/renderer/components/editor/KvEditor.tsx');
    expect(kvSource).not.toContain('isMobileShell');
    expect(kvSource).toContain('<div className="kv-editor kv-editor--glass" data-variant={variant}>');
  });

  it('wears one design-system look in every entity editor, with no shell switch', () => {
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
      const view = source(path);
      expect(view, path).not.toMatch(/const (?:glass|desktop|desktopChrome) = /);
      expect(view, path).not.toMatch(/[!(]glass\b|\bglass (?:\?|&&)/);
      if (path.endsWith('NodeEditorView.tsx')) {
        // The one shell branch left is behaviour: the ⁂ action menu acts on the
        // desktop workspace, so the mobile shell keeps the decorative mark.
        expect(view.match(/isMobileShell/g), path).toHaveLength(1);
        expect(view, path).toContain('{curNode && isChapter(curNode) && !getPlatformRuntime().isMobileShell ? (');
      } else {
        expect(view, path).not.toContain('isMobileShell');
      }
    }
  });

  it('trades the colour slab for the large sand mark and one shared colour picker', () => {
    for (const [path, kind] of [
      ['src/renderer/views/StorylineEditorView.tsx', 'storyline'],
      ['src/renderer/views/CategoryEditorView.tsx', 'category'],
    ] as const) {
      const view = source(path);
      // The colour slab is gone on every shell.
      expect(view).not.toContain('elem-portrait');
      expect(view).toContain(`<KindMark kind="${kind}" color=`);
      expect(view).toContain('className="entity-hero__mark"');
      expect(view).toContain('<div className="col-pick col-pick--glass">');
      expect(view).toContain('<ColorPicker');
      expect(view).not.toContain('col-pick__dot');
    }

    const element = source('src/renderer/views/ElementEditorView.tsx');
    expect(element).toContain('<span className="entity-alias sand-cell">');
    expect(element).toContain('<i className="cell-ring" aria-hidden="true" />');
  });

  it('lists chapters and elements as sidebar cells under a GlassSlider', () => {
    for (const path of ['src/renderer/views/StorylineEditorView.tsx', 'src/renderer/views/CategoryEditorView.tsx']) {
      const view = source(path);
      expect(view).toMatch(/<GlassSlider\s+className="entity-slider"/);
      expect(view).toContain('<div className="mgr-toolbar mgr-toolbar--glass">');
      expect(view).toContain('<div className="mgr-list mgr-list--glass">');
      expect(view).toContain('className="mgr-row mgr-row--glass sand-cell"');
      expect(view).toMatch(/^\s*<i className="cell-ring" aria-hidden="true" \/>$/m);
      // The chip toolbar and status bars of the old look are gone.
      expect(view).not.toMatch(/FilterChip|mgr-toolbar__chips|mgr-row__status/);
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
    expect(panel).toContain(
      'className={`refs-rel-card ${kindClass(rel.otherKind)} refs-rel-card--glass glass glass--rest glass--surface`}',
    );
    // The header's text action opens the picker; there is no trailing add card.
    expect(panel).not.toContain('refs-rel-card--add');
    expect(panel).toContain('<div className="refs-picker refs-picker--glass">');
    expect(panel).toContain('<label className="ui-field glass glass--rest glass--field glass--small">');
    expect(panel).toContain('<Button variant="primary" size="sm" disabled={!pendingTypeId}');
    expect(panel).toMatch(/<GlassSlider\s+className="entity-slider"/);
    expect(panel.split('<div className="refs-cards refs-cards--plain">').length - 1).toBe(2);
    expect(panel).not.toContain('refs-card__kind-dot');
  });

  it('cards each patch, says invalid in ink and sweeps in the Agent’s patch', () => {
    const card = source('src/renderer/components/editor/PatchEditorCard.tsx');
    expect(card).toContain('className={`patch-card patch-card--glass glass glass--rest glass--surface${');
    expect(card).toContain("' patch-card--agent-delete' : ' patch-card--agent-add'} glass-sweep");
    expect(card).toContain('<BrushIcon name="status-warning" size={11} />');
    expect(card).toContain('<div className="patch-card__snapshot glass glass--rest glass--still">');
    expect(card).toContain("'patch-card__anchor-pop-item menu-surface__item' +");
    expect(card).toContain("'patch-card__anchor-pop-item patch-card__anchor-pop-item--detach menu-surface__item' +");
    // The old review strip and its badges are gone.
    expect(card).not.toMatch(/patch-card__review-tag|patch-card--proposed|patch-card--removing|patch-card__invalid-badge/);

    const review = source('src/renderer/components/editor/FieldReview.tsx');
    expect(review).toContain("'field-review--glass',");
    expect(review).toContain("arrived ? 'glass-sweep' : '',");
  });

  it('chooses in dialogs from menu rows and drift conversions from cards of glass', () => {
    const element = source('src/renderer/views/ElementEditorView.tsx');
    expect(element).toContain('<label className="ui-field glass glass--rest glass--field glass--small">');
    expect(element).toContain('menu-surface__item entity-choice__row');
    const node = source('src/renderer/views/NodeEditorView.tsx');
    expect(node).toContain('className="entity-choice-grid"');
    expect(node).toContain("className={`entity-choice-card glass glass--rest${pickedId === opt.id ? ' is-on' : ''}`}");
    expect(node).toContain('menu-surface__item entity-choice__row');
  });

  it('draws the sand-and-glass rules with no wash, shadow or side bar', () => {
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

  it('writes every folio as the mark beside its name in ink', () => {
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

  it('shows only the caret in a field written on the paper or in glass', () => {
    const base = source('src/styles/index.css');
    // The form controls' accent ring stays for boxed controls everywhere else.
    expect(base).toMatch(
      /html input:focus-visible,\s*html textarea:focus-visible,\s*html select:focus-visible \{[^}]*box-shadow: 0 0 0 3px hsl\(var\(--accent\) \/ 0\.22\);/,
    );
    const carveOut = rules(base, ['.glass--field']);
    expect(carveOut).toHaveLength(1);
    const [selector, body] = carveOut[0];
    expect(selector).toContain("html[data-shell-mode]");
    expect(selector).toContain(':is(.editor-shell, .glass--field)');
    expect(selector).toContain(':is(textarea, input:not(');
    for (const boxed of ['checkbox', 'radio', 'range']) expect(selector).toContain(`[type='${boxed}']`);
    expect(selector).not.toContain('select');
    expect(selector).toMatch(/:focus-visible$/);
    expect(body.trim()).toBe('box-shadow: none;');

    // Every structured editor is an editor shell, so its titles, summaries,
    // field rows, aliases, patch titles and material descriptions are covered.
    for (const path of [
      'src/renderer/views/ElementEditorView.tsx',
      'src/renderer/views/CategoryEditorView.tsx',
      'src/renderer/views/StorylineEditorView.tsx',
      'src/renderer/views/NodeEditorView.tsx',
      'src/renderer/views/MaterialEditorView.tsx',
      'src/renderer/views/AllChaptersEditorView.tsx',
    ]) {
      expect(source(path), path).toMatch(/className="editor-shell[" ]/);
    }

    // No editor rule puts an accent wash or ring back under the caret.
    const editors = source('src/styles/entity-editors.css');
    for (const [focusSelector, focusBody] of rules(editors, ['.kv-editor--glass'])) {
      if (!/:focus/.test(focusSelector)) continue;
      expect(focusBody, focusSelector).not.toMatch(/accent/);
    }
  });

  it('sets editor section headers in the Panel Tabs’ upright structure serif', () => {
    const fonts = source('src/styles/interface-fonts.css');
    const structure = [...fonts.matchAll(/html\[data-shell-mode='desktop'\] :is\(([^)]*)\) \{([^}]*)\}/g)].find(
      ([, list]) => list.includes('.workspace-panel-tab-row .app-panel-tab'),
    );
    expect(structure).toBeDefined();
    const [, list, body] = structure!;
    expect(list).toContain('.page__section-title');
    expect(list).toContain('.refs-section__title');
    expect(body).toContain('font-family: var(--font-structure);');
    expect(body).toContain('font-style: normal;');
    expect(body).toContain('font-weight: 400;');

    for (const path of [
      'src/renderer/views/ElementEditorView.tsx',
      'src/renderer/views/CategoryEditorView.tsx',
      'src/renderer/views/StorylineEditorView.tsx',
    ]) {
      expect(source(path), path).toContain('<span className="page__section-title">');
    }
    for (const path of ['src/renderer/components/editor/ReferencesPanel.tsx', 'src/renderer/components/editor/PatchesSection.tsx']) {
      expect(source(path), path).toContain('<span className="refs-section__title">');
    }
  });

  it('says an empty section like an empty template body: the gray content serif, no dashes', () => {
    const empty = renderToStaticMarkup(createElement(KvEditor, { valueJson: '[]', onPersist: () => {}, emptyHint: 'none yet' }));
    expect(empty).toContain('class="kv-editor__empty ui-section-empty"');
    // The add button lives in the section header now, not under the rows.
    expect(empty).not.toContain('kvEditor.addField');
    expect(empty).not.toContain('<button');

    const notes = [
      ['src/renderer/components/editor/KvEditor.tsx', 'kv-editor__empty', 1],
      ['src/renderer/components/editor/PatchesSection.tsx', 'refs-empty', 1],
      ['src/renderer/components/editor/ReferencesPanel.tsx', 'refs-empty', 3],
      ['src/renderer/components/editor/ReferencesPanel.tsx', 'refs-picker__empty', 1],
      ['src/renderer/views/StorylineEditorView.tsx', 'mgr-empty', 1],
      ['src/renderer/views/CategoryEditorView.tsx', 'mgr-empty', 1],
      ['src/renderer/views/MaterialEditorView.tsx', 'material-comments__empty', 1],
    ] as const;
    for (const [path, name, count] of notes) {
      const view = source(path);
      expect(view.split(`className="${name} ui-section-empty"`).length - 1, `${path} ${name}`).toBe(count);
      expect(view, `${path} ${name}`).not.toContain(`className="${name}"`);
    }
    // An empty relation section says so too.
    expect(source('src/renderer/components/editor/ReferencesPanel.tsx')).toContain("t('referencesPanel.empty.relations')");

    const controls = source('src/styles/ui-controls.css');
    const [note, onPaper] = rules(controls, ['.ui-section-empty']);
    expect(note[0]).toBe("html[data-shell-mode] .ui-section-empty");
    expect(note[1]).toContain('font-family: var(--font-content);');
    expect(note[1]).toContain('color: hsl(var(--ink-4));');
    expect(note[1]).toContain('font-style: normal;');
    expect(note[1]).toContain('text-align: left;');
    expect(note[1]).toContain('text-transform: none;');
    expect(note[1]).not.toMatch(/background|border|::before|::after/);
    // On an entity's paper it is the size of the body it stands in for, like the
    // template placeholder (.ProseMirror p.is-editor-empty in index.css).
    expect(onPaper[0]).toBe("html[data-shell-mode] .page--entity .ui-section-empty:not(.refs-picker__empty)");
    expect(onPaper[1]).toContain('font-size: var(--editor-font-size, 17.5px);');
    expect(onPaper[1]).toContain('line-height: var(--editor-line-height, 1.75);');
    const placeholder = rules(source('src/styles/index.css'), ['.is-editor-empty']);
    expect(placeholder[0][1]).toContain('color: hsl(var(--ink-4));');

    // It is no longer index type.
    const fonts = source('src/styles/interface-fonts.css');
    const index = [...fonts.matchAll(/html\[data-shell-mode='desktop'\] :is\(([^)]*)\) \{([^}]*)\}/g)].find(
      ([, list]) => list.includes('.workspace-panel-header-row'),
    );
    expect(index?.[1]).not.toContain('.ui-section-empty');

    // No locale wraps an editor section's empty line in dashes.
    const keys = [
      'kvEditor.empty', 'kvEditor.templateEmpty', 'referencesPanel.picker.empty',
      'referencesPanel.empty.incoming', 'referencesPanel.empty.outgoing', 'referencesPanel.empty.relations',
      'patchesSection.empty', 'storylineEditor.empty.noFacts', 'storylineEditor.empty.noFilteredChapters',
      'storylineEditor.empty.noChapterSummary', 'categoryEditor.empty.noTemplateFields',
      'categoryEditor.empty.noFilteredElements', 'categoryEditor.empty.noSummary', 'elementEditor.empty.noFacts',
    ];
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt-BR']) {
      const catalog = JSON.parse(source(`src/renderer/locales/${locale}.json`));
      for (const key of keys) {
        const text = key.split('.').reduce((node, part) => node?.[part], catalog) as unknown;
        expect(typeof text, `${locale}:${key}`).toBe('string');
        expect(text as string, `${locale}:${key}`).not.toMatch(/^\s*—|—\s*$/);
      }
    }
  });

  it('puts 新增字段 at the right of each field section header', () => {
    for (const path of [
      'src/renderer/views/ElementEditorView.tsx',
      'src/renderer/views/StorylineEditorView.tsx',
      'src/renderer/views/CategoryEditorView.tsx',
    ]) {
      const view = source(path);
      expect(view, path).toContain('<KvAddButton onClick={() => kvRef.current?.addRow()} />');
      expect(view, path).toContain('ref={kvRef}');
      expect(view, path).not.toMatch(/meta\.(facts|templateKv)/);
    }
    const home = source('src/renderer/views/ProjectDashboard.tsx');
    expect(home.split('<KvAddButton className="dash-text-button"').length - 1).toBe(2);
    const editors = source('src/styles/entity-editors.css');
    expect(editors).not.toContain('.kv-editor__add');
    const [header] = rules(editors, ['.page__section']).filter(([selector]) => selector.includes('.refs-section__text-action'));
    expect(header[1]).toContain('text-transform: none;');
  });

  it('documents the entity editors in the component catalogue', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('## 实体编辑器');
    expect(docs).toContain('`entity-editor-glass.acceptance.test.ts`');
    expect(docs).toContain('只有光标');
    expect(docs).toContain('`.ui-section-empty`');
    expect(docs).toContain('`.page__section-title`');
  });
});
