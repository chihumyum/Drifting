import { expect, it } from 'vitest';
import { runAgentJournalScenarios } from '../../../performance/agent-journal-scenarios';

it('owns journal routing, accepted effects, retries and disposal across 100 lifetimes', () => {
  const report = runAgentJournalScenarios();
  expect(report.cycles).toBe(100);
  expect(report.checks).toHaveLength(15);
  expect(report.checks.every(check => check.passed)).toBe(true);
});
