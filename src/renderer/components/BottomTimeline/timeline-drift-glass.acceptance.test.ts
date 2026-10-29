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

import type { BookAct } from '../../domain/book-act';
import type { BookNode } from '../../domain/book-node';
import type { TimelineMarker } from '../../domain/timeline-marker';
import { DriftPanel } from '../DriftPanel';
import { TimelinePin } from '../timeline/TimelinePin';
import { SuperElementDriftCards } from '../../features/graph/SuperElementDriftCards';
import { ActRail } from './ActRail';
import { designSystemDocs } from '../design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function block(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

const stamp = '2026-10-29T00:00:00.000Z';
const act = (id: string, name: string, startOrder: number | null, color: string | null = null): BookAct => ({
  id,
  projectId: 'p',
  name,
  color,
  startOrder,
  driftNodeId: null,
  createdAt: stamp,
  updatedAt: stamp,
});
const marker = (driftNodeId: string | null): TimelineMarker => ({
  id: driftNodeId ? 'bound' : 'free',
  projectId: 'p',
  narrativeOrder: 10,
  label: '黎明',
  driftNodeId,
  createdAt: stamp,
  updatedAt: stamp,
});
const noop = () => undefined;

const rail = (glass: boolean) =>
  renderToStaticMarkup(
    createElement(ActRail, {
      acts: [act('a1', '第一幕', null), act('a2', '第二幕', 30, '#d6b55a')],
      chapters: [
        { id: 'c1', bookOrder: 10 },
        { id: 'c2', bookOrder: 40 },
      ],
      railWidth: 148,
      trackWidth: 600,
      height: 22,
      orderToX: (order) => order * 4,
      minOrder: 0,
      maxOrder: 100,
      onRenameAct: noop,
      onMoveBoundary: noop,
      onDeleteAct: noop,
      onSplitAt: noop,
      onAddAct: noop,
      glass,
    }),
  );

const pin = (driftNodeId: string | null, glass: boolean) =>
  renderToStaticMarkup(
    createElement(TimelinePin, {
      marker: marker(driftNodeId),
      orderToPosition: (order) => order * 4,
      positionToOrder: (x) => x / 4,
      variant: 'bottom',
      pinHeight: 22,
      onChange: noop,
      onDelete: noop,
      onDragMove: noop,
      boundDriftTitle: driftNodeId ? '潮汐表' : null,
      glass,
    }),
  );

describe('Bottom Timeline head, rails and the drift panel in sand and glass', () => {
  it('turns the desktop head into a glass slider, unchanging glass toggles and plain icons', () => {
    const timeline = source('src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx');
    const css = source('src/styles/bottom-timeline.css');

    // 书序 / 叙事时 is one of two on desktop; the paused mobile shell keeps its segments.
    expect(timeline).toContain('<GlassSlider\n              className="btl__view-toggle"');
    expect(timeline).toContain('<SegmentedControl\n              className="btl__view-toggle"');
    // 未归属 and 未放置: one word that never changes, resting glass, pressed or expanded.
    expect(timeline.match(/: 'btl__toggle glass glass--rest glass--small'/g)).toHaveLength(2);
    expect(timeline).toContain('aria-pressed={unaffiliatedVisible}');
    expect(timeline).toContain("{t('bottomTimeline.synthetic.unaffiliated')}");
    // 铺开 and 定位 are a panel header's plain icon buttons; the graph entry stays glass.
    expect(timeline).toMatch(/<GhostIconButton\s+size="sm"\s+title=\{spreadTitle\}/);
    expect(timeline).toMatch(/glass="round"\s+className="workspace-super-view-entry"/);
    // The unplaced popover's rows are menu rows led by the chapter's seal.
    expect(timeline).toContain("'menu-surface__item btl__unplaced-row'");
    expect(timeline).toContain('<KindMark kind="chapter" seed={node.id} color={sl?.color} />');
    // Rails, pins and the storyline names follow the desktop material.
    expect(timeline).toContain('glass={!isMobilePresentation}');
    expect(timeline).toMatch(/<SandCell\s+selected=\{isRouteActive\}/);
    expect(timeline).toContain("t('bottomTimeline.storyline.chapterCount'");
    expect(timeline).not.toContain("'ch' : 'chs'");

    const toggle = block(css, '.btl__toggle {', '.btl__toggle-count {');
    expect(toggle).toContain('border-radius: 0;');
    // Small glass: the dense patch comes from `glass--small`, not a rule of its own.
    expect(toggle).not.toContain('--glass-gx');
    expect(toggle).toMatch(/\[aria-expanded='true'\]\s*\{\s*background: var\(--glass-fill\);/);
    expect(toggle).not.toMatch(/hsl\(var\(--(rule|surface|accent)\)/);
    expect(css).not.toContain('.btl__state-toggle');
    expect(css).toMatch(/\.btl--desktop \.btl-track \{\s*border-radius: 2px;/);
    expect(block(css, '.btl--desktop .btl-axis__rail-add:hover {', '}')).toContain('background: transparent;');
    const rows = block(css, '.btl__unplaced-popover--rows {', '/* ---------------- Unaffiliated toggle');
    expect(rows).toContain('--menu-line: color-mix(in srgb, var(--clip-color, hsl(var(--ink-3))) 50%, var(--glass-clear));');
    expect(rows).not.toContain('background: hsl(');
  });

  it('makes the desktop act rail glass and leaves the paper chips to the paused shell', () => {
    const desktop = rail(true);
    expect(desktop).toContain('class="actrail actrail--glass"');
    expect(desktop).toContain('class="actrail__label is-draggable glass glass--rest glass--small"');
    expect(desktop).not.toContain('accent');

    const plain = rail(false);
    expect(plain).not.toContain('actrail--glass');
    expect(plain).not.toContain('glass--rest');

    const css = source('src/styles/act-rail.css');
    const glass = css.slice(css.indexOf('.actrail--glass {'));
    expect(glass).toContain('--glass-cc: var(--act-color);');
    expect(glass).toMatch(/\.actrail--glass \.actrail__divider:hover::before,[\s\S]*?animation-play-state: running;/);
    expect(glass).toMatch(/\.actrail--glass \.actrail__ghost \{[\s\S]*?mask-position: -96px calc\(var\(--flow, 0\) \* 1\.6px\);/);
    expect(glass).toMatch(/\.actrail__rail-add:hover:not\(:disabled\) \{\s*background: transparent;/);
    expect(glass).not.toContain('hsl(var(--accent))');
    expect(source('src/renderer/components/BottomTimeline/ActRail.tsx')).toContain(
      "className={glass ? 'actrail__edit-field glass glass--field glass--small' : 'actrail__edit-field'}",
    );
  });

  it('carries the desktop time pin as the act chip and its drop line as flowing glass', () => {
    expect(pin(null, true)).toContain('class="btl-pin__label glass glass--rest glass--small"');
    const bound = pin('drift-1', true);
    expect(bound).toContain('kind-mark kind-mark--drift');
    expect(bound).toContain('潮汐表');
    expect(pin('drift-1', false)).not.toContain('kind-mark');
    expect(pin(null, false)).not.toContain('glass');

    const css = source('src/styles/bottom-timeline.css');
    // The accent wash and the CSS eddy stay with the paper (mobile) label only.
    expect(css).toContain('.btl-pin.is-bound .btl-pin__label:not(.glass) {');
    expect(css).toContain('.btl-pin.is-bound .btl-pin__label:not(.glass)::before {');
    expect(css).toContain('.btl-pin.is-bound .btl-pin__label:not(.glass):hover {');
    const desktopPin = block(css, '.btl--desktop .btl-pin__label.glass {', '.btl-pin__label > .kind-mark {');
    expect(desktopPin).not.toContain('accent');
    expect(block(css, '.btl--desktop .btl-pin-line.is-dragging {', '}')).toContain(
      'mask-position: -96px calc(var(--flow, 0) * 1.6px);',
    );
    expect(css).toContain('.btl .actrail:not(.actrail--glass) .actrail__divider:hover::after {');
    expect(source('src/renderer/components/timeline/TimelineGuideLines.tsx')).toContain("'--flow': actX");
  });

  it('floats the drift panel over the graph as glass with the drift eddy', () => {
    const panel = (mounted: boolean) =>
      renderToStaticMarkup(
        createElement(DriftPanel, {
          count: 5,
          mounted,
          open: mounted,
          closing: false,
          onOpen: noop,
          onClose: noop,
          children: null,
        }),
      );
    const closed = panel(false);
    expect(closed).toContain('class="drift-panel__tab glass glass--rest glass--small"');
    expect(closed).toContain('kind-mark kind-mark--drift kind-mark--loose');
    expect(panel(true)).toContain('class="drift-panel__close glass glass--rest glass--round"');

    const node = {
      id: 'd1',
      title: '潮汐表',
      summary: '母亲留下的表比港务局的早四十分钟。',
      writingStatus: 'resting',
      bookOrder: 7,
    } as unknown as BookNode;
    const cards = renderToStaticMarkup(
      createElement(SuperElementDriftCards, {
        nodes: [node],
        linkSourceId: 'd1',
        cardRefs: { current: new Map() },
        onClick: noop,
        onPreviewEnter: noop,
        onPreviewLeave: noop,
      }),
    );
    expect(cards).toContain('class="drift-card glass glass--rest is-link-source is-resting"');
    expect(cards).toContain('kind-mark kind-mark--drift');
    expect(cards).not.toContain('§');
    expect(source('src/renderer/features/graph/StoryGraphDriftCards.tsx')).toContain(
      "isEdgeSelected ? 'is-edge-selected is-on' : ''",
    );

    const css = source('src/styles/drift-panel.css');
    const tab = block(css, '.drift-panel__tab {', '.drift-panel__count {');
    const close = block(css, '.drift-panel__close {', '.drift-panel.is-open');
    const card = block(css, '.drift-card {', '.drift-card__title {');
    for (const rule of [tab, close, card]) {
      expect(rule).toContain('background: var(--glass-fill);');
      expect(rule).not.toMatch(/background: hsl\(var\(--(ink-1|paper|paper-deep|rule)\)/);
      expect(rule).not.toContain('accent');
      expect(rule).not.toContain('dashed');
    }
    expect(close).toContain('border-radius: 50%;');
    expect(card).toMatch(/\.drift-card\.glass\.is-link-source \{\s*--glass-g: 1\.7;\s*--glass-sp: 1\.3;/);
    expect(css).not.toContain('.drift-card__num');
  });

  it('documents the timeline head, rails and the drift panel', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('`actrail--glass`');
    expect(docs).toContain('`btl__toggle`');
    expect(docs).toContain('`btl__unplaced-row`');
    expect(docs).toContain('构想托盘');
  });
});
