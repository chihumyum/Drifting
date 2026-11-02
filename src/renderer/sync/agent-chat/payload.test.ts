import { expect, it } from 'vitest';
import { portableDisplay } from './payload';

it('retains the saved iteration marker in portable usage without admitting execution controls', () => {
  const usage = {
    kind: 'usage', boundary: 'iteration_limit', turns: 50,
    inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
  };
  expect(portableDisplay([{ ...usage, automaticContinuation: 'scheduled' }])).toEqual([usage]);
  const legacy = Object.fromEntries(Object.entries(usage).filter(([key]) => key !== 'boundary'));
  expect(portableDisplay([legacy])).toEqual([legacy]);
});
