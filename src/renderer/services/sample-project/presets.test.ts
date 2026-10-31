import { countWords, countWordsInPmJson } from '@drifting/prose-metrics';
import { describe, expect, it } from 'vitest';
import { createDefaultProjectScenario } from './scenario';
import { allocateSeedLengths, SEED_PRESETS } from './presets';
import { createSeedProse } from './prose';

for (const preset of Object.values(SEED_PRESETS)) describe(`${preset.name} seed word budgets`, () => {
  it('allocates exact bounded totals, includes short/long endpoints and is repeatable', () => {
    for (const budget of [preset.chapters, preset.elements, preset.inspirations, preset.materialNotes, preset.storylines, preset.categories, preset.todos, preset.comments, preset.conversations]) {
      const lengths = allocateSeedLengths(budget, 45);
      expect(lengths).toEqual(allocateSeedLengths(budget, 45));
      expect(lengths).toHaveLength(budget.count);
      expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(budget.total);
      expect(Math.min(...lengths)).toBe(budget.min);
      expect(Math.max(...lengths)).toBe(budget.max);
      expect(new Set(lengths).size).toBeGreaterThanOrEqual(Math.min(budget.count, 3));
    }
  });

  it('generates actual varied-length prose, rather than a forged stored count', () => {
    const document = createDefaultProjectScenario(preset);
    for (const [tool, budget] of [
      ['create_chapter', preset.chapters], ['create_element', preset.elements],
      ['create_inspiration', preset.inspirations], ['create_storyline', preset.storylines],
      ['create_element_category', preset.categories],
    ] as const) {
      const counts = document.steps.filter(step => step.tool === tool).map(step => countWords(String(step.input.body)));
      expect(counts).toHaveLength(budget.count);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(budget.total);
      expect(Math.min(...counts)).toBe(budget.min);
      expect(Math.max(...counts)).toBe(budget.max);
    }
    for (const kind of ['todo', 'note']) {
      const budget = kind === 'todo' ? preset.todos : preset.comments;
      const counts = document.steps.filter(step => step.tool === 'create_comment' && step.input.kind === kind).map(step => countWords(String(step.input.body)));
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(budget.total);
    }
    for (const step of document.steps.filter(step => step.tool === 'create_comment' && step.input.targetText)) {
      expect(step.input.targetType).toBe('chapter');
      expect(typeof step.input.targetName).toBe('string');
      const target = document.steps.find(candidate => candidate.tool === 'create_chapter' && candidate.input.title === step.input.targetName);
      expect(String(target?.input.body)).toContain(String(step.input.targetText));
    }
    for (const [index, length] of allocateSeedLengths(preset.materialNotes, 108).entries()) {
      const note = createSeedProse(length, 8_000 + index, true);
      expect(countWordsInPmJson(JSON.stringify(note))).toBe(length);
      expect(note.content?.some(block => block.type === 'taskList')).toBe(true);
    }
  });
});

it('keeps the author-requested heavy and lite corpus sizes as explicit contracts', () => {
  expect(SEED_PRESETS.stress.chapters).toMatchObject({ count: 100, total: 1_500_000, min: 2_000, max: 20_000 });
  expect(SEED_PRESETS.stress.elements).toMatchObject({ count: 300, total: 500_000, min: 100, max: 10_000 });
  expect(SEED_PRESETS.stress.inspirations).toMatchObject({ count: 200, total: 1_000_000, min: 1_000, max: 50_000 });
  expect(SEED_PRESETS.stress.materialNotes).toMatchObject({ total: 500_000, min: 500, max: 10_000 });
  expect(SEED_PRESETS.lite.chapters).toMatchObject({ count: 20, total: 150_000 });
  expect(SEED_PRESETS.lite.elements).toMatchObject({ count: 30, total: 50_000 });
  expect(SEED_PRESETS.lite.inspirations).toMatchObject({ count: 10, total: 20_000 });
  expect(SEED_PRESETS.lite.storylines.count).toBe(2);
});

it('rejects impossible word budgets instead of silently clipping their totals', () => {
  expect(() => allocateSeedLengths({ count: 10, total: 20_000, min: 1_000, max: 50_000 }, 1)).toThrow('budget');
});
