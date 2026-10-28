export type SeedPresetName = 'stress' | 'lite';

export interface SeedWordBudget {
  count: number;
  total: number;
  min: number;
  max: number;
  skew?: number;
}

export interface SeedPreset {
  name: SeedPresetName;
  chapters: SeedWordBudget;
  elements: SeedWordBudget;
  inspirations: SeedWordBudget;
  materialNotes: SeedWordBudget;
  storylines: SeedWordBudget;
  categories: SeedWordBudget;
  todos: SeedWordBudget;
  comments: SeedWordBudget;
  conversations: SeedWordBudget;
  assetCopies: number;
}

export const SEED_PRESETS: Record<SeedPresetName, SeedPreset> = {
  stress: {
    name: 'stress',
    chapters: { count: 100, total: 1_500_000, min: 2_000, max: 20_000 },
    elements: { count: 300, total: 500_000, min: 100, max: 10_000, skew: 3 },
    inspirations: { count: 200, total: 1_000_000, min: 1_000, max: 50_000, skew: 4 },
    materialNotes: { count: 60, total: 500_000, min: 500, max: 10_000 },
    storylines: { count: 3, total: 60_000, min: 5_000, max: 30_000 },
    categories: { count: 16, total: 16_000, min: 100, max: 3_000, skew: 2 },
    todos: { count: 120, total: 30_000, min: 50, max: 1_500, skew: 3 },
    comments: { count: 80, total: 40_000, min: 50, max: 3_000, skew: 3 },
    // Here total/min/max measure rounds, rather than words.
    conversations: { count: 24, total: 1_800, min: 6, max: 600, skew: 4 },
    assetCopies: 6,
  },
  lite: {
    name: 'lite',
    chapters: { count: 20, total: 150_000, min: 2_000, max: 20_000 },
    elements: { count: 30, total: 50_000, min: 100, max: 10_000, skew: 3 },
    inspirations: { count: 10, total: 20_000, min: 1_000, max: 5_000, skew: 2 },
    materialNotes: { count: 12, total: 20_000, min: 500, max: 4_000 },
    storylines: { count: 2, total: 8_000, min: 1_500, max: 6_500 },
    categories: { count: 6, total: 1_800, min: 100, max: 600 },
    todos: { count: 12, total: 1_200, min: 40, max: 240 },
    comments: { count: 8, total: 1_200, min: 40, max: 300 },
    conversations: { count: 3, total: 24, min: 4, max: 12 },
    assetCopies: 1,
  },
};

export function seedPreset(name: string = 'stress'): SeedPreset {
  if (name !== 'stress' && name !== 'lite') throw new Error(`Unknown seed preset: ${name}`);
  return SEED_PRESETS[name];
}

/** Stable PRNG. No dates, machine state or global Math.random in the corpus. */
export function seedRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Exact bounded totals, both endpoints represented, deterministically shuffled. */
export function allocateSeedLengths(budget: SeedWordBudget, seed: number): number[] {
  const { count, total, min, max, skew = 1 } = budget;
  if (![count, total, min, max].every(Number.isSafeInteger) || count < 2 || min < 1 || max < min
    || total < max + (count - 1) * min || total > min + (count - 1) * max)
    throw new Error('Seed length budget cannot represent its total and endpoints');
  const random = seedRandom(seed);
  const values = Array<number>(count).fill(min);
  values[1] = max;
  const weights = values.map(() => 0.01 + random() ** skew);
  let remaining = total - values.reduce((sum, value) => sum + value, 0);
  while (remaining > 0) {
    const candidates = values.map((value, index) => ({ value, index }))
      .filter(({ value, index }) => index > 1 && value < max);
    if (!candidates.length) throw new Error('Seed length allocation exhausted capacity');
    const weight = candidates.reduce((sum, { index }) => sum + weights[index], 0);
    const available = remaining;
    for (const { index } of candidates) {
      const amount = Math.min(max - values[index], Math.floor(available * weights[index] / weight), remaining);
      values[index] += amount;
      remaining -= amount;
    }
    if (remaining === available) {
      for (const { index } of candidates) {
        if (!remaining) break;
        values[index] += 1;
        remaining -= 1;
      }
    }
  }
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}
