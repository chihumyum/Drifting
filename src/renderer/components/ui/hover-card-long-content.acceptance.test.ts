import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function block(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing block: ${start} -> ${end}`);
  return text.slice(from, to + end.length);
}

describe('hover cards with long content', () => {
  it('lets the pointer into a prose link card, which covers at most 480px and scrolls the rest', () => {
    const area = source('src/renderer/components/editor/EditorMainArea.tsx');
    const card = block(area, '<EntityHoverCard', '/>');

    expect(area).toContain('const PROSE_HOVER_CARD_MAX_HEIGHT = 480;');
    expect(card).toContain('pointer={entityHoverCard}');
    expect(card).toContain('onDismiss={entityHoverDismiss}');
    expect(card).toContain('maxHeight={PROSE_HOVER_CARD_MAX_HEIGHT}');
    expect(source('src/renderer/features/entities/hover/EntityHoverCard.tsx')).toContain('maxHeight={maxHeight}');
  });

  it('runs facts in, so a long key never squeezes its value into a narrow column', () => {
    const controls = source('src/styles/ui-controls.css');
    const kv = block(controls, '.hover-card__kv {', '}');

    expect(kv).not.toContain('grid-template-columns');
    expect(block(controls, '.hover-card__kv dt {', '}')).toContain('display: inline;');
    expect(block(controls, '.hover-card__kv dd {', '}')).toContain('display: inline;');
    expect(block(controls, '.hover-card__kv-row {', '}')).toContain('overflow-wrap: anywhere;');
    // Every card with facts groups each key with its value.
    for (const file of [
      'src/renderer/features/entities/hover/EntityHoverCard.tsx',
      'src/renderer/components/graph/RelationEdgePopover.tsx',
    ]) {
      expect(source(file), file).toContain('className="hover-card__kv-row"');
    }
  });

  it('fades the body at its lower edge while more is below', () => {
    const controls = source('src/styles/ui-controls.css');
    const shell = source('src/renderer/components/ui/HoverCard.tsx');

    expect(block(controls, '.hover-card__body--more {', '}')).toContain('mask-image: linear-gradient(to bottom, #000 calc(100% - 32px), transparent);');
    expect(shell).toContain("moreBelow ? ' hover-card__body--more' : ''");
    expect(shell).toContain('onScroll={updateMoreBelow}');
  });
});
