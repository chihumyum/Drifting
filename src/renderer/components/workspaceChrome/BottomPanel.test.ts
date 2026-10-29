import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BottomPanel, BottomPanelHeader } from './BottomPanel';
import { BOTTOM_PANEL_DEFAULT_HEIGHT, useBottomPanel } from './bottom-panel-context';

function HeightProbe({ name }: { name: string }) {
  const panel = useBottomPanel();
  return createElement('i', { 'data-probe': name }, String(panel?.height ?? 'none'));
}

describe('the Bottom Panel', () => {
  const render = (show: 'timeline' | 'planner') =>
    renderToStaticMarkup(
      createElement(BottomPanel, {
        show,
        children: {
          timeline: createElement(HeightProbe, { name: 'timeline' }),
          planner: createElement(HeightProbe, { name: 'planner' }),
        },
      }),
    );

  it('is one shell with its own height and top-edge handle, holding only the shown pane', () => {
    const markup = render('timeline');
    expect(markup).toContain(`class="bottom-panel" style="height:${BOTTOM_PANEL_DEFAULT_HEIGHT}px"`);
    expect(markup).toContain('<div class="bottom-panel__resize"></div>');
    expect(markup.match(/class="bottom-panel__pane"/g)).toHaveLength(1);
    expect(markup).toContain('data-bottom-pane="timeline"');
    expect(markup).not.toContain('data-probe="planner"');
    // Both panes read the one shared height from the shell.
    expect(markup).toContain(`<i data-probe="timeline">${BOTTOM_PANEL_DEFAULT_HEIGHT}</i>`);
    expect(render('planner')).toContain(`<i data-probe="planner">${BOTTOM_PANEL_DEFAULT_HEIGHT}</i>`);
  });

  it('gives a pane outside the panel no shell to read', () => {
    expect(renderToStaticMarkup(createElement(HeightProbe, { name: 'loose' }))).toContain('>none</i>');
  });

  it('opens every pane with the same header row: what it shows, then its actions', () => {
    const markup = renderToStaticMarkup(
      createElement(BottomPanelHeader, { className: 'btl__head', start: 'Book', end: 'Spread' }),
    );
    expect(markup).toBe(
      '<div class="bottom-panel-head btl__head"><div class="bottom-panel-head__start">Book</div>'
        + '<div class="bottom-panel-head__end">Spread</div></div>',
    );
    expect(renderToStaticMarkup(createElement(BottomPanelHeader, { start: 'Plan' }))).not.toContain('__end');
  });
});
