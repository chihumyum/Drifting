import { beforeEach, expect, it, vi } from 'vitest';
import { runInlineEdit, type InlineEditTarget } from './inline-edit';
import { runStructured } from '../ai/run-structured';

vi.mock('../ai/run-structured', () => ({ runStructured: vi.fn() }));
const model = vi.mocked(runStructured);
beforeEach(() => model.mockReset());

const target = (): InlineEditTarget => ({
  spanWithinBlock: true, spanSource: { blockId: 'synthetic-source-block', blockKind: 'paragraph', contentJson: '[{"type":"text","text":"Synthetic source"}]' },
  from: 1, to: 17, selectedText: 'Synthetic source', blockContext: 'Synthetic context', targetBlocks: [],
});

it('keeps the exact span precondition local while returning it with the proposal', async () => {
  model.mockResolvedValue({ refused: false, reason: 'Synthetic reason', editedText: 'Synthetic revision' });
  const source = target();
  const result = await runInlineEdit({ target: source, instruction: 'Polish', allowNewContent: false, projectId: 'synthetic-project' });
  expect(result.span?.source).toBe(source.spanSource);
  const input = model.mock.calls[0][1];
  expect(input).toMatchObject({ selectedText: 'Synthetic source', instruction: 'Polish' });
  expect(input).not.toHaveProperty('spanSource');
  expect(input).not.toHaveProperty('source');
  expect(JSON.stringify(input)).not.toContain('synthetic-source-block');
});

it('carries every block precondition through model index mapping without sending it', async () => {
  model.mockResolvedValue({ refused: false, reason: '', blocks: [{ index: 1, text: ' Revised first ' }, { index: 1, text: 'Ignored duplicate' }, { index: 3, text: 'Ignored extra' }] });
  const source = { ...target(), spanWithinBlock: false, spanSource: null, targetBlocks: [
    { id: 'synthetic-a', kind: 'paragraph', text: 'First', sourceJson: 'synthetic exact first snapshot' },
    { id: 'synthetic-b', kind: 'paragraph', text: 'Second', sourceJson: 'synthetic exact second snapshot' },
  ] };
  const result = await runInlineEdit({ target: source, instruction: 'Polish', allowNewContent: false, projectId: 'synthetic-project' });
  expect(result.blocks?.map(block => ({ id: block.id, text: block.newText, changed: block.changed, source: block.sourceJson }))).toEqual([
    { id: 'synthetic-a', text: 'Revised first', changed: true, source: source.targetBlocks[0].sourceJson },
    { id: 'synthetic-b', text: 'Second', changed: false, source: source.targetBlocks[1].sourceJson },
  ]);
  expect(model.mock.calls[0][1]).toMatchObject({ blocks: [{ index: 1, kind: 'paragraph', text: 'First' }, { index: 2, kind: 'paragraph', text: 'Second' }] });
  expect(JSON.stringify(model.mock.calls[0][1])).not.toContain('snapshot');
});

it('retains local refusal without making a model request', async () => {
  expect((await runInlineEdit({ target: target(), instruction: '继续续写新情节', allowNewContent: false, projectId: 'synthetic-project' })).refused).toBe(true);
  expect(model).not.toHaveBeenCalled();
});
