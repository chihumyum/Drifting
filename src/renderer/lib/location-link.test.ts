import { describe, expect, it } from 'vitest';

import {
  blockIndexToLine,
  canonicalLocationHref,
  contentJsonBlockIds,
  contentJsonLocationTargets,
  createLocationResolver,
  describeLocationHref,
  formatLocationHref,
  lineToBlockIndex,
  markdownLocationHrefs,
  parseLocationHref,
  type LocationCatalog,
  type LocationEntity,
} from './location-link';

const rain: LocationEntity = { kind: 'node', id: 'node-rain', group: 'chapters', name: '雨夜' };
const elias: LocationEntity = { kind: 'element', id: 'element-elias', group: 'elements', name: '伊莱亚斯' };

function catalog(blocks: Record<string, Array<string | null>>, entities = [rain, elias]): LocationCatalog {
  return { projectId: 'project-1', entities, blockIds: (_kind, id) => blocks[id] };
}

describe('location link addresses', () => {
  it('parses the document, operating-system and projection-relative forms', () => {
    expect(parseLocationHref('drifting:chapters/雨夜/prose.md#L12-L18')).toEqual({
      projectId: null, group: 'chapters', reference: '雨夜', byId: false, startLine: 12, endLine: 18, explicit: true,
    });
    expect(parseLocationHref('drifting://open/project-1/chapters/id-node-rain/prose.md#L3')).toMatchObject({
      projectId: 'project-1', reference: 'node-rain', byId: true, startLine: 3, endLine: null,
    });
    expect(parseLocationHref('../../chapters/id-node%2Drain/prose.md#L5-7')).toMatchObject({
      group: 'chapters', reference: 'node-rain', byId: true, startLine: 5, endLine: 7, explicit: false,
    });
    expect(parseLocationHref('/elements/人物/伊莱亚斯/body.md')).toMatchObject({
      group: 'elements', reference: '伊莱亚斯', startLine: null,
    });
    expect(parseLocationHref('project/storylines/id-s1/index.md')).toMatchObject({ group: 'storylines', byId: true });
    // Percent-encoded destinations (browsers, the chat renderer) decode too.
    expect(parseLocationHref('drifting:chapters/%E9%9B%A8%E5%A4%9C/prose.md#l4')).toMatchObject({
      reference: '雨夜', startLine: 4,
    });
  });

  it('rejects ordinary and malformed links', () => {
    for (const href of [
      'https://example.test/chapters/x/prose.md',
      '人物.md#伊莱亚斯',
      'chapters/雨夜',
      'drifting:chapters/雨夜/prose.md#第三段',
      'drifting:chapters/雨夜/prose.md#L5-L3',
      'drifting:chapters/雨夜/prose.md#L0',
      'drifting:comments/x/index.md',
      'drifting:chapters/a/b/prose.md',
      'drifting:chapters/../elements/x/prose.md',
    ]) expect(parseLocationHref(href), href).toBeNull();
  });

  it('maps lines to blocks with the projection layout', () => {
    expect([1, 2, 3, 4, 5].map(lineToBlockIndex)).toEqual([0, 0, 1, 1, 2]);
    expect([0, 1, 2].map(blockIndexToLine)).toEqual([1, 3, 5]);
  });

  it('escapes names so they survive Markdown and URI parsing', () => {
    const href = canonicalLocationHref({
      projectId: null, group: 'chapters', reference: '50% / 上#下?', byId: false, startLine: 3, endLine: null, explicit: true,
    });
    expect(href).toBe('drifting:chapters/50%25 %2F 上%23下%3F/prose.md#L3');
    expect(parseLocationHref(href)?.reference).toBe('50% / 上#下?');
    expect(formatLocationHref({ group: 'drifts', segment: 'id-a', projectId: 'p 1' })).toBe(
      'drifting://open/p%201/drifts/id-a/prose.md',
    );
    expect(describeLocationHref('drifting:chapters/雨夜/prose.md#L3-L5')).toBe('chapters/雨夜 L3-L5');
  });

  it('finds location links in Agent Markdown and stored documents', () => {
    expect(markdownLocationHrefs('见[雨夜](drifting:chapters/雨夜/prose.md#L3)与[官网](https://x.test)')).toEqual([
      'drifting:chapters/雨夜/prose.md#L3',
    ]);
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'p1' }, content: [
          { type: 'text', text: '雨夜', marks: [{ type: 'entityLink', attrs: { targetKind: 'node', targetId: 'node-rain', targetBlockId: 'b2', targetEndBlockId: null } }] },
          { type: 'text', text: '伊莱亚斯', marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId: 'element-elias', targetBlockId: null } }] },
        ] },
        { type: 'paragraph' },
      ],
    };
    expect(contentJsonBlockIds(JSON.stringify(doc))).toEqual(['p1', null]);
    expect(contentJsonLocationTargets(doc)).toEqual([
      { targetKind: 'node', targetId: 'node-rain', targetBlockId: 'b2', targetEndBlockId: null },
    ]);
  });
});

describe('location link resolver', () => {
  it('resolves lines to stable paragraphs and renders their current lines', () => {
    const blocks: Record<string, Array<string | null>> = { 'node-rain': ['b1', 'b2', 'b3', 'b4', 'b5'] };
    const resolver = createLocationResolver(catalog(blocks));
    const single = resolver.resolve('drifting:chapters/雨夜/prose.md#L4');
    expect(single).toMatchObject({ ok: true, attrs: { targetKind: 'node', targetId: 'node-rain', targetBlockId: 'b2', targetEndBlockId: null } });
    const range = resolver.resolve('drifting:chapters/雨夜/prose.md#L3-L7');
    expect(range).toMatchObject({ ok: true, attrs: { targetBlockId: 'b2', targetEndBlockId: 'b4' } });
    if (!range?.ok) throw new Error('expected a range');
    expect(resolver.format(range.attrs)).toBe('drifting:chapters/雨夜/prose.md#L3-L7');

    // A paragraph inserted above moves the rendered lines, not the anchor.
    blocks['node-rain'] = ['b0', ...blocks['node-rain']!];
    expect(resolver.format(range.attrs)).toBe('drifting:chapters/雨夜/prose.md#L5-L9');
    // A deleted cited paragraph still opens the chapter.
    blocks['node-rain'] = ['b0', 'b3'];
    expect(resolver.format(range.attrs)).toBe('drifting:chapters/雨夜/prose.md');
    expect(resolver.format({ ...range.attrs, targetId: 'gone' })).toBeNull();
  });

  it('reports why a link cannot be resolved', () => {
    const resolver = createLocationResolver(catalog({ 'node-rain': ['b1', 'b2'] }));
    expect(resolver.resolve('https://example.test')).toBeNull();
    expect(resolver.resolve('drifting:chapters/晴天/prose.md#L1')).toEqual({ ok: false, error: 'No chapter named "晴天"' });
    expect(resolver.resolve('drifting:drifts/雨夜/prose.md#L1')).toMatchObject({ ok: false });
    expect(resolver.resolve('drifting:chapters/雨夜/prose.md#L5')).toEqual({
      ok: false, error: '"雨夜" has lines 1–3; line 5 does not exist',
    });
    expect(resolver.resolve('drifting://open/other/chapters/雨夜/prose.md#L1')).toMatchObject({ ok: false });
    expect(resolver.resolve('drifting:elements/伊莱亚斯/prose.md#L1')).toEqual({
      ok: false, error: 'The body of "伊莱亚斯" is not available',
    });
    expect(resolver.resolve('drifting:elements/伊莱亚斯/prose.md')).toMatchObject({
      ok: true, attrs: { targetKind: 'element', targetId: 'element-elias', targetBlockId: null },
    });
  });

  it('falls back to the stable id directory for ambiguous names', () => {
    const twin: LocationEntity = { ...rain, id: 'node-rain-2' };
    const resolver = createLocationResolver(catalog({ 'node-rain': ['b1'], 'node-rain-2': ['c1'] }, [rain, twin]));
    expect(resolver.resolve('drifting:chapters/雨夜/prose.md#L1')).toMatchObject({ ok: false });
    const byId = resolver.resolve('chapters/id-node-rain-2/prose.md#L1');
    expect(byId).toMatchObject({ ok: true, attrs: { targetId: 'node-rain-2', targetBlockId: 'c1' } });
    if (!byId?.ok) throw new Error('expected an id link');
    expect(resolver.format(byId.attrs)).toBe('drifting:chapters/id-node-rain-2/prose.md#L1');
  });
});
