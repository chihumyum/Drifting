import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceSharingFixture } from '../../performance/workspace-fixture';
import { createGlobalSearchIndex, searchGlobalDocuments } from './global-search-model';

const body = (text: string) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const labels = { untitled: 'Untitled', unnamed: 'Unnamed' };
function fixture() {
  const data = createWorkspaceSharingFixture('synthetic-search', 1);
  data.bookNodes[0] = { ...data.bookNodes[0], title: 'NEEDLE title', summary: 'needle summary', kind: 'drift', bookOrder: null, writingStatus: 'drifting' };
  data.storylines = [{ ...data.storylines[0], name: 'needle line', summary: '', contentJson: body('needle line body') }];
  data.bookElements[0] = { ...data.bookElements[0], name: 'needle element', summary: '', contentJson: body('needle element body') };
  data.bookElementCategories = [{ ...data.bookElementCategories[0], name: 'needle category', contentJson: body('needle category body') }];
  return data;
}
afterEach(() => vi.restoreAllMocks());
describe('visible global-search projection', () => {
  it('preserves entity order, drift nodes, field order, case-insensitive matching and literal punctuation', () => {
    const data = fixture(); const index = createGlobalSearchIndex();
    const docs = index.prepare('one', data, new Map([[data.bookNodes[0].id, body('needle 100% _value \\path')]]), labels);
    const groups = searchGlobalDocuments(docs, ' NEEDLE ');
    expect(groups.map(group => group.entityType)).toEqual(['node', 'storyline', 'element', 'category']);
    expect(groups[0].occurrences.map(hit => hit.field)).toEqual(['title', 'summary', 'body']);
    for (const query of ['100%', '_value', '\\path']) expect(searchGlobalDocuments(docs, query)).toHaveLength(1);
    expect(searchGlobalDocuments(docs, '   ')).toEqual([]);
    expect(searchGlobalDocuments(docs, 'missing')).toEqual([]);
  });
  it('caps matches across fields while retaining the omitted count and valid highlights', () => {
    const data = fixture(); data.bookNodes[0].title = 'needle'; data.bookNodes[0].summary = '';
    const group = searchGlobalDocuments(createGlobalSearchIndex().prepare('one', data,
      new Map([[data.bookNodes[0].id, body('needle '.repeat(40))]]), labels), 'needle')[0];
    expect(group.occurrences).toHaveLength(30); expect(group.truncated).toBe(11);
    for (const hit of group.occurrences) expect(hit.excerpt.slice(hit.matchStart, hit.matchStart + hit.matchLen)).toBe('needle');
  });
  it('keeps metadata searchable when JSON is malformed or a node body is absent', () => {
    const data = fixture(); data.bookElements[0].contentJson = '{bad'; data.storylines[0].contentJson = '';
    const groups = searchGlobalDocuments(createGlobalSearchIndex().prepare('one', data, new Map(), labels), 'needle');
    expect(groups[0].occurrences.map(hit => hit.field)).toEqual(['title', 'summary']);
    expect(groups[1].occurrences.map(hit => hit.field)).toEqual(['name']);
    expect(groups[2].occurrences.map(hit => hit.field)).toEqual(['name']);
  });
  it('reuses unchanged JSON across queries and renames, but parses a changed body', () => {
    const data = fixture(); const index = createGlobalSearchIndex(); const parse = vi.spyOn(JSON, 'parse');
    const prepare = () => index.prepare('one', data, new Map(), labels);
    prepare(); expect(parse).toHaveBeenCalledTimes(3); parse.mockClear();
    data.bookElements[0] = { ...data.bookElements[0], name: 'Renamed' };
    expect(searchGlobalDocuments(prepare(), 'Renamed')[0].entityTitle).toBe('Renamed');
    searchGlobalDocuments(prepare(), 'needle'); expect(parse).not.toHaveBeenCalled();
    data.bookElements[0] = { ...data.bookElements[0], contentJson: body('replacement') };
    expect(searchGlobalDocuments(prepare(), 'replacement')).toHaveLength(1); expect(parse).toHaveBeenCalledTimes(1);
  });
  it('releases removed entities and does not reuse a no-longer-returned node body', () => {
    const data = fixture(); const index = createGlobalSearchIndex(); const bodies = new Map([[data.bookNodes[0].id, body('needle')]]);
    const element = data.bookElements[0]; index.prepare('one', data, bodies, labels);
    data.bookElements = []; const docs = index.prepare('one', data, new Map(), labels);
    expect(searchGlobalDocuments(docs, 'needle')[0].occurrences).toHaveLength(2);
    const parse = vi.spyOn(JSON, 'parse'); data.bookElements = [element];
    index.prepare('one', data, bodies, labels); expect(parse).toHaveBeenCalledTimes(2);
  });
  it('releases every cached body across generation changes and explicit close', () => {
    const data = fixture(); const index = createGlobalSearchIndex(); index.prepare('project:g1', data, new Map(), labels);
    const parse = vi.spyOn(JSON, 'parse'); index.prepare('project:g2', data, new Map(), labels);
    expect(parse).toHaveBeenCalledTimes(3); index.clear(); parse.mockClear();
    index.prepare('project:g2', data, new Map(), labels); expect(parse).toHaveBeenCalledTimes(3);
  });
  it('keeps identical ids from different entity kinds and projects independent', () => {
    const data = fixture(); data.storylines[0].id = data.bookElements[0].id;
    const index = createGlobalSearchIndex(); const docs = index.prepare('project-a', data, new Map(), labels);
    expect(searchGlobalDocuments(docs, 'line body')[0].entityType).toBe('storyline');
    data.bookElements[0].contentJson = body('other project');
    expect(searchGlobalDocuments(index.prepare('project-b', data, new Map(), labels), 'other project')[0].entityType).toBe('element');
  });
  it('uses localized fallbacks and joins paragraphs without searching JSON attributes', () => {
    const data = fixture(); data.bookNodes[0].title = ''; data.bookElements[0].name = '';
    const json = JSON.stringify({ type: 'doc', attrs: { hidden: 'private-marker' }, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'first needle' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'second needle' }] },
    ] });
    const docs = createGlobalSearchIndex().prepare('one', data, new Map([[data.bookNodes[0].id, json]]), labels);
    const groups = searchGlobalDocuments(docs, 'needle'); expect(groups[0].entityTitle).toBe('Untitled');
    expect(groups.find(group => group.entityType === 'element')?.entityTitle).toBe('Unnamed');
    expect(groups[0].occurrences.some(hit => hit.excerpt.includes('first needle second needle'))).toBe(true);
    expect(searchGlobalDocuments(docs, 'private-marker')).toEqual([]);
  });
});
