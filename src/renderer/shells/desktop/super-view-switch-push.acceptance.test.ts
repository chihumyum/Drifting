import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('../../platform/runtime', () => ({
  getPlatformRuntime: () => ({ isMobileShell: false, isMacDesktop: false, desktopWindowControls: false }),
}));

// The real views load on demand through virtual modules; a stand-in per view
// is enough to see which slides the stage renders.
vi.mock('./views/DeferredSuperViews', () => {
  const view = (name: string) => () => createElement('div', { className: 'super-view-overlay', 'data-view': name });
  return {
    DeferredElementGraphView: view('element'),
    DeferredStoryGraphView: view('graph'),
    DeferredMemoMaterialView: view('memo-material'),
  };
});

import { SuperViewHeader } from '../../components/SuperViewHeader';
import { SuperViewShell } from '../../components/SuperViewShell';
import { SuperViewLeavingContext } from '../../components/super-view-leaving';
import { DesktopSuperViewStage } from './DesktopSuperViewStage';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const leaving = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(createElement(SuperViewLeavingContext.Provider, { value: true }, element));

describe('switching Super Views pushes the block under the header', () => {
  it('keeps a view being pushed away on screen with an empty header and no input', () => {
    const header = createElement(SuperViewHeader, {
      onBack: () => undefined,
      meta: '2 故事线',
      navigationSlot: createElement('button', { type: 'button' }, '切换'),
      rightSlot: createElement('button', { type: 'button' }, '全部'),
    });
    const arriving = renderToStaticMarkup(header);
    expect(arriving).toContain('super-view-head__back');
    expect(arriving).toContain('切换');
    // Its box stays so the block does not jump; its switch leaves with it.
    expect(leaving(header)).toBe('<div class="super-view-head" aria-hidden="true"></div>');

    const shell = createElement(SuperViewShell, { className: 'graph-overlay', children: 'body' });
    expect(renderToStaticMarkup(shell)).toBe('<div class="super-view-overlay graph-overlay">body</div>');
    expect(leaving(shell)).toBe('<div class="super-view-overlay graph-overlay" inert="" aria-hidden="true">body</div>');
  });

  it('renders only the open view at rest, and nothing when closed', () => {
    const open = renderToStaticMarkup(createElement(DesktopSuperViewStage, { active: 'graph' }));
    expect(open).toBe('<div class="super-view-slide"><div class="super-view-overlay" data-view="graph"></div></div>');
    expect(renderToStaticMarkup(createElement(DesktopSuperViewStage, { active: 'none' }))).toBe('');
  });

  it('hosts every Super View in the stage and pushes on the sidebar push', () => {
    const host = source('src/renderer/shells/desktop/DesktopOverlayHost.tsx');
    expect(host).toContain('<DesktopSuperViewStage active={activeSuperView} />');
    expect(host).not.toMatch(/activeSuperView === '(graph|element|memo-material)'/u);

    const stage = source('src/renderer/shells/desktop/DesktopSuperViewStage.tsx');
    for (const name of ['PUSH_MS', 'PUSH_EASING', 'PUSH_OUTLINE_FADE_MS', 'planSidebarPush', 'trackGlassFlow', 'chooseSuperView']) {
      expect(stage).toContain(name);
    }
    // A view still loading is replaced mid-push and joins where its shell was.
    expect(stage).toContain('new MutationObserver');
    expect(stage).toContain('clock.currentTime');
    // Only the stage's own pushes are cancelled, never a view's CSS motion.
    expect(stage).toContain('new WeakMap<Element, Animation>()');
    expect(stage).not.toMatch(/getAnimations\(\)/u);
  });

  it('stacks the arriving view over the one it pushes and skips it all under reduced motion', () => {
    const css = source('src/styles/super-view-header.css').replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(css).toMatch(/\.super-view-slide \{\s*display: contents;/u);
    expect(css).toMatch(/\.super-view-slide--in \.super-view-overlay \{\s*background: transparent;/u);
    expect(css).toMatch(/\.super-view-slide--out \.super-view-overlay \{\s*z-index: 249;\s*pointer-events: none;/u);
    expect(css).toMatch(/\.super-view-slide__outline \{\s*position: fixed;\s*z-index: 251;\s*pointer-events: none;/u);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.super-view-slide--out,\s*\.super-view-slide__outline \{\s*display: none;/u);
  });

  it('is written down with the motion vocabulary and the Super View header', () => {
    expect(source('docs/design-system/motion.md')).toContain('Super View 之间切换');
    expect(source('docs/design-system/motion.md')).toContain('`DesktopSuperViewStage.tsx`');
    expect(source('docs/design-system/components.md')).toContain('**切换时推开下面整块**');
  });
});
