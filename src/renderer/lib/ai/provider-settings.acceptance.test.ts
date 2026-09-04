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
    const text = await source(
      '/src/renderer/features/settings/desktop/DesktopSettingsModal.tsx',
    );
    const intelligence = await source(
      '/src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx',
    );
    const agent = await source('/src/renderer/features/settings/panels/AgentSettingsPanel.tsx');
    const models = between(
      intelligence,
      'export function ModelsPanel(',
      'export function CopilotPanel(',
    );
    const copilot = intelligence.slice(intelligence.indexOf('export function CopilotPanel('));

    expect(text).toContain("id: 'models'");
    expect(models.match(/<ProviderRow/g)).toHaveLength(4);
    expect(models).toContain('<ChatGptSubscriptionRow');
    expect(intelligence).toContain("events.emit('agent:auth-changed')");
    expect(copilot).not.toContain('<ProviderRow');
    expect(agent).not.toContain('<ProviderRow');
    expect(agent).not.toContain('AgentAuthRow');
    expect(text).not.toContain('function ShadowPanel(');
  });

  it('leaves feature routing with each consumer and General Agent selection in chat', async () => {
    const settings = await source(
      '/src/renderer/features/settings/desktop/DesktopSettingsModal.tsx',
    );
    const companion = await source('/src/renderer/features/agent/desktop/DesktopAgentPanel.tsx');
    const intelligence = await source(
      '/src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx',
    );
    const agent = await source('/src/renderer/features/settings/panels/AgentSettingsPanel.tsx');
    const composer = await source('/src/renderer/features/agent/AgentComposerConfig.tsx');
    const runtime = await source('/src/renderer/lib/agent/useDriftingAgentRuntime.ts');
    const copilot = intelligence.slice(intelligence.indexOf('export function CopilotPanel('));

    expect(copilot).toContain('setCopilotByokProvider');
    expect(copilot).toContain('<CopilotByokModelPicker />');
    expect(settings).not.toContain('setShadowByokProvider');
    expect(settings).not.toContain('setShadowByokModel');
    expect(agent).not.toContain('setAgentProvider');
    expect(agent).not.toContain('setAgentModel');
    expect(composer).toContain('setAgentProvider');
    expect(composer).toContain('setAgentModel');
    expect(companion).toContain("railId: 'models'");
    expect(companion).toContain('isGeneralAgentUsable(agentAuth, status)');
    expect(runtime).toContain('chatgptConnected');
    expect(runtime).toContain('platform.codexSubscription');
  });

  it('tests every credential directly without a hosted BYOK relay', async () => {
    const intelligence = await source(
      '/src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx',
    );
    const connection = await source('/src/renderer/lib/ai/test-provider-connection.ts');

    expect(intelligence).toContain('testByokProviderConnection(provider');
    expect(intelligence).not.toContain('apiClient');
    expect(connection).toContain('buildDirectBYOKClient');
    expect(connection).toContain('platform.openAIResponses.request');
    expect(connection).not.toContain(['/api/ai/byok', 'test'].join('/'));
  });
});
