import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/core';
import type { BlockSection } from '../../domain/block-section';
import { useDataStore } from '../../store/data-store';
import { mergeChapterSegments } from './merge-chapter-segments';
import { produceBlockSectionSummary } from './produce-block-section-summary';

const services = vi.hoisted(() => ({ generate: vi.fn(), replace: vi.fn(), create: vi.fn() }));
vi.mock('../ai/run-structured', () => ({ runStructured: services.generate }));
vi.mock('../ai/prompts/templates/segment-merge', () => ({ segmentMergePrompt: {} }));
vi.mock('../ai/prompts/templates/block-section-summary', () => ({ blockSectionSummaryPrompt: {} }));
vi.mock('../../usecase/synced-entity-commands', () => ({ replaceBlockSectionsWithSync: services.replace, createBlockSectionWithSync: services.create }));

const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', attrs: { id: { default: null } } }, text: {} } });
const section = (id: string): BlockSection => ({ id, projectId: 'synthetic-project', chapterId: 'synthetic-chapter', blockIds: [id], blockHashes: {}, summary: 'Synthetic summary', source: 'copilot-rolling', createdAt: '2026-01-01', updatedAt: '2026-01-01' });
const originalSections = useDataStore.getState().blockSections;
beforeEach(() => {
  vi.resetAllMocks();
  useDataStore.setState({ blockSections: [section('a'), section('b')] });
  services.create.mockResolvedValue(section('new')); services.replace.mockResolvedValue(section('new'));
});
afterEach(() => useDataStore.setState({ blockSections: originalSections }));

describe.each(['merge', 'rolling'] as const)('%s summary cancellation', kind => {
  function fixture() {
    const doc = schema.node('doc', null, ['a', 'b'].map(id => schema.node('paragraph', { id }, schema.text('Synthetic prose'))));
    const editor = { isDestroyed: false, isEditable: true, state: { doc } } as unknown as Editor;
    const controller = new AbortController();
    const run = () => kind === 'merge'
      ? mergeChapterSegments({ editor, projectId: 'synthetic-project', chapterId: 'synthetic-chapter', signal: controller.signal })
      : produceBlockSectionSummary({ editor, projectId: 'synthetic-project', chapterId: 'synthetic-chapter', blockIds: ['a', 'b'], signal: controller.signal });
    const writes = kind === 'merge' ? services.replace : services.create;
    return { editor, controller, run, writes };
  }
  it('does not scan or request work for a retired owner', async () => {
    const { editor, controller, run, writes } = fixture(); controller.abort();
    const scan = vi.spyOn(editor.state.doc, 'descendants'); await run();
    expect(scan).not.toHaveBeenCalled(); expect(services.generate).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });
  it('ignores a provider result delivered after disabling Copilot', async () => {
    const { editor, controller, run, writes } = fixture();
    let resolve!: (result: { summary: string }) => void;
    services.generate.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = run(); expect(services.generate).toHaveBeenCalledOnce();
    controller.abort(); const scan = vi.spyOn(editor.state.doc, 'descendants');
    resolve({ summary: 'Late synthetic response' }); await pending;
    expect(scan).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    expect(useDataStore.getState().blockSections.map(s => s.id)).toEqual(['a', 'b']);
  });
  it('still persists the current owner result', async () => {
    const { run, writes } = fixture(); services.generate.mockResolvedValue({ summary: 'Current synthetic response' }); await run();
    expect(writes).toHaveBeenCalledOnce(); expect(useDataStore.getState().blockSections.some(s => s.id === 'new')).toBe(true);
  });
});
