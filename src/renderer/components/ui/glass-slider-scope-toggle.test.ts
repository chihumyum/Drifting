import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import '../../lib/i18n';
import { GlassSlider } from './GlassSlider';
import { ScopeToggle } from './ScopeToggle';

const css = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('glass slider', () => {
  const render = (value: 'all' | 'comment' | 'todo') =>
    renderToStaticMarkup(
      createElement(GlassSlider<'all' | 'comment' | 'todo'>, {
        ariaLabel: 'Type',
        value,
        onChange: () => {},
        options: [
          { value: 'all', label: 'All' },
          { value: 'comment', label: 'Notes' },
          { value: 'todo', label: 'TODO' },
        ],
      }),
    );

  it('sets the options in one radio group with a single glass slider under the choice', () => {
    const markup = render('comment');
    expect(markup).toContain('role="radiogroup" aria-label="Type"');
    expect(markup.match(/role="radio"/g)).toHaveLength(3);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup).toContain('aria-checked="true" tabindex="0" data-value="comment"');
    // Only the slider is glass, in its still selected state; the options are words.
    expect(markup.match(/[" ]glass(?=[" ])/g)).toHaveLength(1);
    expect(markup).toContain('class="glass-slider__thumb glass is-on"');
  });

  it('slides on the dock spring with no track, square like the panel-tab block, and stays put under reduced motion', () => {
    const controls = css('src/styles/ui-controls.css');
    expect(controls).toContain(
      'transform var(--slider-ms) var(--slider-ease),\n    width var(--slider-ms) var(--slider-ease),\n    height var(--slider-ms) var(--slider-ease);',
    );
    const track = controls.slice(controls.indexOf('.glass-slider {'), controls.indexOf('.glass-slider__thumb {'));
    expect(track).toContain('background: transparent;');
    expect(track).toContain('border-radius: 0;');
    const thumb = controls.slice(controls.indexOf('.glass-slider__thumb {'), controls.indexOf('.glass-slider__thumb[data-visible'));
    expect(thumb).toContain('border-radius: 0;');
    expect(controls).toContain(".glass-slider[data-placed='true'] .glass-slider__thumb {\n    transition: none;");
    expect(css('src/renderer/components/ui/GlassSlider.tsx')).toContain("'--slider-ms': `${SPRING_MS}ms`,\n          '--slider-ease': weightedEasing(),");
    // Small glass reads its rim from the dense texture patch the panel-tab
    // block uses, and the slider's glass runs with its travel like that block.
    expect(controls).toContain('.glass-slider > .glass-slider__thumb.glass {\n  --glass-gx: calc(var(--flow, 0) * 1.2px + var(--glass-dense-gx));\n  --glass-gy: var(--glass-dense-gy);');
    expect(css('src/renderer/components/ui/GlassSlider.tsx')).toContain(
      'trackGlassFlow(track, () => (vertical ? element.getBoundingClientRect().top : element.getBoundingClientRect().left));',
    );
  });

  it('folds into the chosen option alone when collapsed, opening the rest stacked on hover', () => {
    const markup = renderToStaticMarkup(
      createElement(GlassSlider<'all' | 'comment' | 'todo'>, {
        ariaLabel: 'Type',
        value: 'todo',
        onChange: () => {},
        collapsed: true,
        onNaturalWidth: () => {},
        options: [
          { value: 'all', label: 'All' },
          { value: 'comment', label: 'Notes' },
          { value: 'todo', label: 'TODO' },
        ],
      }),
    );
    // One tab: the chosen option on the glass, a trigger for the stacked list.
    expect(markup).toContain('class="glass-slider glass-slider--collapsed"');
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain('aria-haspopup="dialog" aria-expanded="false"');
    expect(markup).toContain('>TODO</button>');
    expect(markup).not.toContain('role="radio"');
    expect(markup.match(/[" ]glass(?=[" ])/g)).toHaveLength(1);
    // A hidden copy still measures every option side by side.
    expect(markup).toContain('<span aria-hidden="true" class="glass-slider__measure">');
    expect(markup.match(/<span class="glass-slider__option">/g)).toHaveLength(3);

    const controls = css('src/styles/ui-controls.css');
    expect(controls).toContain('.glass-slider--vertical {\n  flex-direction: column;');
    expect(controls).toContain('.glass-slider__measure {\n  position: absolute;');
    expect(controls).toContain('visibility: hidden;');
    // The opened list sits on body yet keeps the panel header's size and voice.
    expect(controls).toContain(":is(.workspace-panel-header-row, .glass-slider-popover) :is(.glass-slider__option, .scope-toggle)");
    expect(css('src/styles/interface-fonts.css')).toContain(':is(.workspace-panel-header-row, .glass-slider-popover, .left-sb-inline-group-header) :is(button, span)');
    const source = css('src/renderer/components/ui/GlassSlider.tsx');
    expect(source).toContain('placement="bottom-start"');
    expect(source).toContain('orientation="vertical"');
    // Choosing slides the same heavy slab and leaves the list open; only the
    // pointer leaving closes it.
    expect(source).toContain('orientation="vertical"\n            onChange={onChange}\n          />');
  });
});

describe('scope toggle', () => {
  it('says 当前 for every kind of thing, in every panel', () => {
    const word = (markup: string) => markup.replace(/<[^>]+>/g, '');
    const toggle = renderToStaticMarkup(createElement(ScopeToggle, { pressed: false, onToggle: () => {} }));
    expect(word(toggle)).toBe('Current');
    expect(toggle).toContain('title="Only what belongs to the current item"');
    expect(JSON.parse(css('src/renderer/locales/zh-CN.json')).scopeToggle.label).toBe('当前');
    for (const panel of ['src/renderer/components/rightBars/ReviewPanel.tsx', 'src/renderer/features/library/LibraryPanel.tsx']) {
      expect(css(panel)).not.toContain('scopeToggleSubject');
    }
  });

  it('keeps one word in both states and shows the state as lock-like glass', () => {
    const off = renderToStaticMarkup(createElement(ScopeToggle, { pressed: false, onToggle: () => {} }));
    const on = renderToStaticMarkup(createElement(ScopeToggle, { pressed: true, onToggle: () => {} }));
    const word = (markup: string) => markup.replace(/<[^>]+>/g, '');
    expect(word(off)).toBe(word(on));
    expect(off).toContain('class="scope-toggle glass glass--rest glass--small"');
    expect(off).toContain('aria-pressed="false"');
    expect(on).toContain('aria-pressed="true"');
    expect(css('src/styles/ui-controls.css')).toContain(".scope-toggle[aria-pressed='true'] {\n  background: var(--glass-fill);");
  });
});
