import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function source(path: string): Promise<string> {
  return readFile(`${CORE_ROOT}${path}`, 'utf8');
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('central AI provider settings acceptance', () => {
  it('keeps every writable provider credential inside Models & API', async () => {
    const text = await source('/src/renderer/components/modals/SettingsModal.tsx');
    const models = between(text, 'function ModelsPanel(', 'function ShadowProviderKeyStatus(');
    const copilot = between(text, 'function CopilotPanel(', 'function AgentMemorySection(');
    const shadow = between(text, 'function ShadowPanel(', 'const COPILOT_DEBOUNCE_MIN_SEC');
    const agent = between(text, 'function AgentPanel(', 'function KeysPanel(');

    expect(text).toContain("id: 'models'");
    expect(models.match(/<ProviderRow/g)).toHaveLength(4);
    expect(copilot).not.toContain('<ProviderRow');
    expect(shadow).not.toContain('<ProviderRow');
    expect(agent).not.toContain('<ProviderRow');
    expect(agent).not.toContain('AgentAuthRow');
  });

  it('leaves feature routing with each consumer and General Agent selection in chat', async () => {
    const settings = await source('/src/renderer/components/modals/SettingsModal.tsx');
    const companion = await source('/src/renderer/components/agent/CompanionPanel.tsx');
    const copilot = between(settings, 'function CopilotPanel(', 'function AgentMemorySection(');
    const shadow = between(settings, 'function ShadowPanel(', 'const COPILOT_DEBOUNCE_MIN_SEC');
    const agent = between(settings, 'function AgentPanel(', 'function KeysPanel(');

    expect(copilot).toContain('setCopilotByokProvider');
    expect(copilot).toContain('<CopilotByokModelPicker />');
    expect(shadow).toContain('setShadowByokProvider');
    expect(shadow).toContain('setShadowByokModel');
    expect(agent).not.toContain('setAgentProvider');
    expect(agent).not.toContain('setAgentModel');
    expect(companion).toContain('setAgentProvider');
    expect(companion).toContain('setAgentModel');
    expect(companion).toContain("railId: 'models'");
  });
});
