import { describe, expect, it } from 'vitest';
import {
  AGENT_WORKING_MEMORY_SOFT_TOKENS,
  AGENT_WORKING_MEMORY_TARGET_TOKENS,
} from '../../../domain/agent-working-memory';
import { estimateAgentContextTextTokens } from './context-planner';
import { compactAgentWorkingMemoryMarkdown } from './working-memory-document';

function entry(index: number, character: string): string {
  return `### 2026-08-${String(12 - index).padStart(2, '0')}\n\n- ${character.repeat(1_350)}\n`;
}

describe('Working Memory rolling Markdown', () => {
  it('leaves a bounded document byte-stable', () => {
    const content = '# Working Memory\n\n## Current\n\n- 继续验收。\n\n## Recent\n';
    const result = compactAgentWorkingMemoryMarkdown(content);

    expect(result).toEqual({
      contentMd: content,
      approxTokens: estimateAgentContextTextTokens(content),
      compacted: false,
      retiredEntries: 0,
    });
  });

  it('retires the oldest summary and oldest recent entries while keeping Current and newest exact work', () => {
    const content = [
      '# Working Memory',
      '',
      '## Current',
      '',
      '- 下一位 Agent 必须继续移动端验收。',
      '',
      '## Recent',
      '',
      entry(0, '甲'),
      entry(1, '乙'),
      entry(2, '丙'),
      entry(3, '丁'),
      entry(4, '戊'),
      '',
      '## Earlier summary',
      '',
      `- ${'旧'.repeat(1_200)}`,
    ].join('\n');
    expect(estimateAgentContextTextTokens(content)).toBeGreaterThan(
      AGENT_WORKING_MEMORY_SOFT_TOKENS,
    );

    const result = compactAgentWorkingMemoryMarkdown(content);

    expect(result.compacted).toBe(true);
    expect(result.retiredEntries).toBeGreaterThan(0);
    expect(result.approxTokens).toBeLessThanOrEqual(AGENT_WORKING_MEMORY_TARGET_TOKENS);
    expect(result.contentMd).toContain('下一位 Agent 必须继续移动端验收');
    expect(result.contentMd).toContain('甲'.repeat(60));
    expect(result.contentMd).toContain('乙'.repeat(60));
    expect(result.contentMd).not.toContain('## Earlier summary');
    expect(result.contentMd).not.toContain('戊'.repeat(60));
  });

  it('fails closed when protected current work plus the newest exact records exceed the hard limit', () => {
    const content = `# Working Memory\n\n## Current\n\n- ${'未'.repeat(8_500)}\n\n## Recent\n`;

    expect(() => compactAgentWorkingMemoryMarkdown(content)).toThrow('WORKING_MEMORY_TOO_LARGE');
  });

  it('also retires oldest bullet records from an ordinary Markdown Recent section', () => {
    const memory = [
      '# Working Memory',
      '',
      '## Current',
      '',
      '- 保留当前阻塞。',
      '',
      '## Recent',
      '',
      `- newest ${'新'.repeat(2_600)}`,
      `- middle ${'中'.repeat(2_600)}`,
      `- oldest ${'旧'.repeat(2_600)}`,
    ].join('\n');

    const result = compactAgentWorkingMemoryMarkdown(memory);

    expect(result.compacted).toBe(true);
    expect(result.contentMd).toContain('newest');
    expect(result.contentMd).toContain('middle');
    expect(result.contentMd).not.toContain('oldest');
  });
});
