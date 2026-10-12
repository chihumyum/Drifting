import { describe, expect, it } from 'vitest';
import { estimateAgentContextTextTokens } from './context-planner';
import {
  agentWorkingMemoryNoticeTier,
  applyAgentWorkingMemoryEdits,
  decideAgentWorkingMemoryNotice,
  measureAgentWorkingMemoryMarkdown,
} from './working-memory-document';

describe('Working Memory rolling Markdown', () => {
  it('leaves a document byte-stable and reports its size without any ceiling', () => {
    const content = '# Working Memory\n\n## Current\n\n- 继续验收。\n\n## Recent\n';
    expect(measureAgentWorkingMemoryMarkdown(content)).toEqual({
      contentMd: content,
      approxTokens: estimateAgentContextTextTokens(content),
    });
    const huge = `# Working Memory\n\n## Recent\n\n- ${'长'.repeat(200_000)}\n`;
    expect(measureAgentWorkingMemoryMarkdown(huge).contentMd).toBe(huge);
  });

  it('edits passages in order like a Markdown file', () => {
    const content = '# Working Memory\n\n## Current\n\n- 修第三章\n\n## Recent\n';
    const next = applyAgentWorkingMemoryEdits(content, [
      { oldText: '- 修第三章\n', newText: '' },
      { oldText: '## Recent\n', newText: '## Recent\n\n- 第三章已修完\n' },
    ]);
    expect(next).toBe('# Working Memory\n\n## Current\n\n\n## Recent\n\n- 第三章已修完\n');
  });

  it('rejects edits whose passage is missing or ambiguous', () => {
    const content = '- 甲\n- 甲\n';
    expect(() => applyAgentWorkingMemoryEdits(content, [{ oldText: '- 乙', newText: '' }])).toThrow(
      'WORKING_MEMORY_EDIT_NOT_FOUND',
    );
    expect(() => applyAgentWorkingMemoryEdits(content, [{ oldText: '- 甲', newText: '' }])).toThrow(
      'WORKING_MEMORY_EDIT_AMBIGUOUS',
    );
  });

  it('prompts once at 20k and 40k tokens and on every turn above 80k', () => {
    expect([0, 20_001, 40_001, 80_000, 80_001].map(agentWorkingMemoryNoticeTier)).toEqual([
      0, 1, 2, 2, 3,
    ]);
    expect(decideAgentWorkingMemoryNotice(19_000, 0)).toEqual({ notice: false, notifiedTier: 0 });
    expect(decideAgentWorkingMemoryNotice(25_000, 0)).toEqual({ notice: true, notifiedTier: 1 });
    expect(decideAgentWorkingMemoryNotice(30_000, 1)).toEqual({ notice: false, notifiedTier: 1 });
    expect(decideAgentWorkingMemoryNotice(60_000, 1)).toEqual({ notice: true, notifiedTier: 2 });
    expect(decideAgentWorkingMemoryNotice(70_000, 2)).toEqual({ notice: false, notifiedTier: 2 });
    expect(decideAgentWorkingMemoryNotice(90_000, 3)).toEqual({ notice: true, notifiedTier: 3 });
    expect(decideAgentWorkingMemoryNotice(90_000, 3)).toEqual({ notice: true, notifiedTier: 3 });
    // Shrinking re-arms the notice for the next crossing.
    expect(decideAgentWorkingMemoryNotice(10_000, 3)).toEqual({ notice: false, notifiedTier: 0 });
    expect(decideAgentWorkingMemoryNotice(21_000, 0)).toEqual({ notice: true, notifiedTier: 1 });
  });
});
