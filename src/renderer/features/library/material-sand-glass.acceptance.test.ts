import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

import { designSystemDocs } from '../../components/design-system-docs.test-support';
import { MaterialRegionLayer, type RegionMark } from './MaterialRegionLayer';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function block(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

const marks: RegionMark[] = [
  { id: 'c1', index: 1, region: { v: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, resolved: false, todo: false },
  { id: 'c2', index: 2, region: { v: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, resolved: true, todo: true },
];

const layer = (sand: boolean) =>
  renderToStaticMarkup(
    createElement(MaterialRegionLayer, {
      box: { width: 400, height: 300, page: null },
      marks,
      selectedId: 'c1',
      linkedId: 'c2',
      drawing: false,
      sand,
      onSelect: () => undefined,
      onLink: () => undefined,
      onDrawn: () => undefined,
    }),
  );

describe('materials in sand and glass on the desktop', () => {
  it('draws region comments as sand frames numbered with a sand seal', () => {
    const desktop = layer(true);
    expect(desktop).toContain('class="material-region material-region--sand material-region--selected"');
    expect(desktop).toContain(
      'class="material-region material-region--sand material-region--linked material-region--resolved material-region--todo"',
    );
    expect(desktop.match(/<canvas class="material-region__frame" aria-hidden="true">/g)).toHaveLength(2);
    expect(desktop).toContain('class="material-region__badge material-region__badge--seal"');

    // The paused mobile shell keeps the outlined boxes.
    const mobile = layer(false);
    expect(mobile).not.toContain('material-region--sand');
    expect(mobile).not.toContain('<canvas');

    // The frame is the selected-cell brush, drawn for the region's own size
    // with a seed kept per comment; selecting draws it round again.
    const regions = source('src/renderer/features/library/MaterialRegionLayer.tsx');
    expect(regions).toContain('drawSandStroke({ width: width - SAND_FRAME_PAD * 2, height: height - SAND_FRAME_PAD * 2, dpr, seed })');
    expect(regions).toContain('const seed = seedOf(id);');
    expect(regions).toContain('selected && !wasSelected.current && !reducedMotion()');
    // The composer is a floating layer: a paper field, note or TODO as one of
    // a set, cancel as a text button and save as the primary.
    expect(regions).toContain('className="region-composer region-composer--float"');
    expect(regions).toContain('className="region-composer__field glass glass--rest glass--field"');
    expect(regions).toContain('<GlassSlider');
    expect(regions).toContain('<Button size="sm" variant="ghost" onClick={onCancel}>');
    expect(regions).toContain('<Button size="sm" variant="primary" disabled={!body.trim()} onClick={submit}>');

    const css = source('src/styles/material-workbench.css');
    const region = block(css, '.material-region.material-region--sand {', '}');
    expect(region).toContain('border: 0;');
    expect(region).toContain('background: transparent;');
    expect(block(css, '.material-region__frame {', '}')).toContain('mix-blend-mode: var(--pigment-blend);');
    expect(block(css, '.material-region__badge--seal::before,', '}')).toContain("url('../assets/design/sand/blob-2.png')");
  });

  it('puts the stage tools and PDF paging in glass pills and lays the header on the desk', () => {
    const editor = source('src/renderer/views/MaterialEditorView.tsx');
    const stage = source('src/renderer/features/library/MaterialMediaStage.tsx');
    const lightbox = source('src/renderer/features/library/LibraryItemPreview.tsx');
    const css = source('src/styles/material-workbench.css');

    expect(editor).toContain('<div className="editor-bar glass glass--rest" role="toolbar" aria-label={t(\'materialEditor.toolbar\')}>');
    expect(editor).toContain("className={`editor-bar__icon glass glass--round${drawing ? ' editor-bar__icon--active' : ''}`}");
    expect(editor).toContain('aria-pressed={drawing}');
    expect(editor).toContain('className="material-stage__zoom glass"');
    expect(editor).toContain('<span className="material-editor__description-field glass glass--field">{field}</span>');
    expect(editor).toContain("className={`material-comments${glass ? ' material-comments--flat' : ''}`}");
    expect(editor).toContain('material-seal');
    expect(stage).toContain('className="material-stage__pager-bar"');
    expect(stage).toContain('<BrushIcon name="chevron-left" size={14} />');
    expect(lightbox).toContain("className={`material-lightbox${glass ? ' material-lightbox--desk' : ''}`}");
    expect(lightbox).toContain('glass="round"');

    const header = block(css, ":root:not([data-shell-mode='mobile']) .material-editor__header {", '}');
    expect(header).toContain('border-bottom: 0;');
    expect(header).toContain('background: transparent;');
    expect(block(css, ":root:not([data-shell-mode='mobile']) .material-stage__media {", '}')).toContain(
      'box-shadow: var(--page-elevation);',
    );
    expect(block(css, '.material-comments.material-comments--flat {', '}')).toContain('background: transparent;');
    expect(block(css, '.material-lightbox--desk {', '}')).toContain('hsl(var(--paper-deep)) 96%');
  });

  it('keeps no second layer of colour on a note sheet and highlights in sand', () => {
    const css = source('src/styles/material-workbench.css');
    const bar = source('src/renderer/views/NoteFloatingBar.tsx');
    const embed = source('src/renderer/features/library/MaterialEmbedView.tsx');
    const note = source('src/renderer/views/MaterialNotePage.tsx');

    const mark = block(css, ":root:not([data-shell-mode='mobile']) .note-prose mark,", '}');
    expect(mark).toContain("background: url('../assets/design/sand/hl-mark.png') center / 100% 100% no-repeat;");
    expect(mark).toContain('box-decoration-break: clone;');
    expect(css).toContain("background-image: url('../assets/design/sand/hl-mark-dark.png');");
    const readOnly = block(css, ":root:not([data-shell-mode='mobile']) .note-prose pre,", '}');
    expect(readOnly).toContain('background: transparent;');
    expect(block(css, ":root:not([data-shell-mode='mobile']) .note-prose pre::before,", '}')).toContain(
      'var(--glass-texture)',
    );
    expect(block(css, ":root:not([data-shell-mode='mobile']) .note-prose blockquote {", '}')).toContain(
      'background: transparent;',
    );
    const checkbox = block(css, ":root:not([data-shell-mode='mobile']) .note-prose ul[data-type='taskList'] li > label input {", '}');
    expect(checkbox).toContain('appearance: none;');
    expect(checkbox).toContain("url('../assets/design/icons/task-todo.png')");
    expect(css).toContain("mask-image: url('../assets/design/icons/task-done.png');");

    expect(bar).toContain("className={`note-floating-bar${float ? ' note-floating-bar--float' : ''}`}");
    expect(bar).toContain("className={float ? 'menu-surface__item' : undefined}");
    expect(block(css, '.note-floating-bar.note-floating-bar--float {', '}')).toContain(
      'box-shadow: var(--menu-surface-shadow);',
    );
    expect(embed).toContain("` note-embed__card--glass glass glass--rest${selected ? ' is-on' : ''}`");
    expect(embed).toContain('<KindMark kind="material" />');
    expect(note).toContain("className={`note-embed-picker__tile${glass ? ' note-embed-picker__tile--glass glass glass--rest' : ''}`}");
  });

  it('makes library materials sand cells, TODOs glass cards and folders cells', () => {
    const card = source('src/renderer/features/library/LibraryItemCard.tsx');
    const todo = source('src/renderer/features/library/TodoCard.tsx');
    const tree = source('src/renderer/features/library/MaterialFolderTree.tsx');
    const picker = source('src/renderer/features/library/MaterialFolderPicker.tsx');
    const dialogs = source('src/renderer/features/library/LibraryDialogs.tsx');
    const css = source('src/styles/material-workbench.css');

    expect(card).toContain("'sand-cell',");
    expect(card).toContain('<KindMark kind="material" color="hsl(var(--ink-3))" />');
    expect(card).toContain('<SandFrame selected={active} />');
    expect(card).toContain('{glass ? glassCard : legacyCard}');
    // The mobile shell keeps its touch menu.
    expect(card).toContain('className="library-item-card__mobile-menu"');
    expect(todo).toContain('todo-card todo-card--glass glass glass--rest glass--surface');
    expect(block(css, '.todo-card__kind {', '}')).toContain('color: var(--material-todo-c);');

    expect(tree).toContain("${desktop ? ' sand-cell' : ''}");
    expect(tree).toContain("{desktop && <i className=\"cell-ring\" aria-hidden=\"true\" />}");
    expect(tree).toContain('<i className="material-tree__drop-ring" aria-hidden="true" />');
    expect(tree).toContain('className="material-tree__rename-field glass glass--rest glass--field"');
    const washes = block(css, '.material-tree--desktop .material-tree__row:hover,', '}');
    expect(washes).toContain('background: transparent;');

    expect(picker).toContain("glass && current ? 'is-on' : ''");
    expect(picker).toContain('<Button type="submit" size="sm" variant="primary" disabled={!name.trim()}>');
    expect(dialogs).toContain('className="material-field library-dialog__field glass glass--rest glass--field"');
    expect(dialogs).toContain("variant={glass ? 'ghost' : 'default'}");
    expect(block(css, '.material-field {', '}')).toContain('background: hsl(var(--page));');

    const docs = designSystemDocs();
    expect(docs).toContain('## 素材页');
    expect(docs).toContain('## 区域批注');
    expect(docs).toContain('## 笔记正文');
    expect(docs).toContain('## 素材库卡片');
  });
});
