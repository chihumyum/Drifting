import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

async function source(path: string): Promise<string> {
  return readFile(`${CORE_ROOT}${path}`, 'utf8');
}

function between(text: string, start: string, end?: string): string {
  const startIndex = text.indexOf(start);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = end ? text.indexOf(end, startIndex + start.length) : text.length;
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('Shadow shared AgentRuntime acceptance', () => {
  it('keeps the semantic judge on the canonical runtime instead of a local provider loop', async () => {
    const text = await source('/src/renderer/lib/ai/shadow-rules.ts');
    const judge = between(text, 'export async function evaluateSemanticAssertionsWithRuntime(');

    expect(judge).toContain('runShadowAgentRuntime({');
    expect(judge).toContain('completionTool: SUBMIT_VERDICTS_TOOL.name');
    expect(judge).not.toContain('client.complete(');
    expect(judge).not.toMatch(/for \(let round\s*=/);
  });

  it('keeps the evolve editor on the same runtime with an explicit tiny write profile', async () => {
    const text = await source('/src/renderer/lib/agent/tool-handlers.ts');
    const editor = between(
      text,
      'export async function runShadowEditBatch(',
      'async function shadowCommitReview(',
    );

    expect(editor).toContain('runShadowAgentRuntime({');
    expect(editor).toContain('completionTool: EVOLVE_FINISH_TOOL.name');
    expect(editor).toContain("name === 'edit_block'");
    expect(editor).toContain("name === 'edit_blocks'");
    expect(editor).not.toContain('client.complete(');
    expect(editor).not.toMatch(/for \(let round\s*=/);
  });

  it('centralizes Shadow policy in a thin profile over AgentRuntime and its provider driver', async () => {
    const text = await source('/src/renderer/lib/shadow/agent-runtime.ts');

    expect(text).toContain('new AgentRuntime({');
    expect(text).toContain('new DriftingAgentModelDriver({');
    expect(text).toContain('new OpenAICompatibleCompletionDriver({');
    expect(text).toContain('resolveAgentProviderContextProfile');
    expect(text).toContain("kind: 'shadow'");
    expect(text).toContain('completionTool: {');
    expect(text).toContain("toolSearch: 'off'");
    expect(text).not.toContain('.complete({');
  });

  it('shares global BYOK credentials and certified provider drivers across agents', async () => {
    const text = await source('/src/renderer/lib/ai/client/build-default-client.ts');
    const shadowFactory = between(
      text,
      'export async function buildShadowClient(',
      '/**\n * General Agent P1 client.',
    );
    const generalFactory = between(
      text,
      'export async function buildGeneralAgentClient(',
      'async function buildDirectDeepSeekClient(',
    );

    expect(shadowFactory).toContain('useSettingsStore.getState().shadowByokProvider');
    expect(shadowFactory).toContain('new AnthropicProvider({');
    expect(shadowFactory).toContain('new OpenAIProvider({');
    expect(shadowFactory).toContain("buildDirectDeepSeekClient(options, 'Shadow', credentials)");
    expect(generalFactory).toContain(
      "buildDirectDeepSeekClient(options, 'General Agent', credentials)",
    );
  });
});
