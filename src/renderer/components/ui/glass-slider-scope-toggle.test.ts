import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import '../../lib/i18n';
import { GlassSlider } from './GlassSlider';
import { ScopeToggle } from './ScopeToggle';
import { scopeToggleSubject } from './scope-toggle';

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
      'transform var(--slider-ms) var(--slider-ease),\n    width var(--slider-ms) var(--slider-ease);',
    );
    const track = controls.slice(controls.indexOf('.glass-slider {'), controls.indexOf('.glass-slider__thumb {'));
    expect(track).toContain('background: transparent;');
    expect(track).toContain('border-radius: 0;');
    const thumb = controls.slice(controls.indexOf('.glass-slider__thumb {'), controls.indexOf('.glass-slider__thumb[data-visible'));
    expect(thumb).toContain('border-radius: 0;');
    expect(controls).toContain(".glass-slider[data-placed='true'] .glass-slider__thumb {\n    transition: none;");
    expect(css('src/renderer/components/ui/GlassSlider.tsx')).toContain("import { springEasing } from '../topBars/TopTimeline/tab-reorder';");
  });
});

describe('scope toggle', () => {
  it('names the current thing by its kind, a drift node as an idea', () => {
    expect(scopeToggleSubject('node')).toBe('chapter');
    expect(scopeToggleSubject('node', true)).toBe('drift');
    expect(scopeToggleSubject('element')).toBe('element');
    expect(scopeToggleSubject('library_item')).toBe('material');
    expect(scopeToggleSubject(null)).toBe('current');
  });

  it('keeps one word in both states and shows the state as lock-like glass', () => {
    const off = renderToStaticMarkup(createElement(ScopeToggle, { subject: 'chapter', pressed: false, onToggle: () => {} }));
    const on = renderToStaticMarkup(createElement(ScopeToggle, { subject: 'chapter', pressed: true, onToggle: () => {} }));
    const word = (markup: string) => markup.replace(/<[^>]+>/g, '');
    expect(word(off)).toBe(word(on));
    expect(off).toContain('class="scope-toggle glass glass--rest"');
    expect(off).toContain('aria-pressed="false"');
    expect(on).toContain('aria-pressed="true"');
    expect(css('src/styles/ui-controls.css')).toContain(".scope-toggle[aria-pressed='true'] {\n  background: var(--glass-fill);");
  });
});
