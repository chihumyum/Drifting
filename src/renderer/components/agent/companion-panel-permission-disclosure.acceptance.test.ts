import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('General Agent permission disclosure', () => {
  it('shows a natural domain action before a collapsed raw-argument disclosure', () => {
    const panel = source('src/renderer/components/agent/CompanionPanel.tsx');
    const naturalDescription = panel.indexOf('describeAgentPermissionAction(');
    const rawDisclosure = panel.indexOf(
      "<summary>{t('agentPanel.control.arguments')}</summary>",
    );

    expect(naturalDescription).toBeGreaterThan(-1);
    expect(rawDisclosure).toBeGreaterThan(naturalDescription);
    expect(panel.slice(rawDisclosure - 20, rawDisclosure)).toContain('<details>');
    expect(panel).not.toContain('EditFilePermissionPreview');
  });

  it('keeps the dangerous-operation switch explicit and off by default', () => {
    const panel = source('src/renderer/components/agent/CompanionPanel.tsx');
    const settings = source('src/renderer/store/settings-store.ts');

    expect(panel).toContain('agentAllowDangerousOperations');
    expect(panel).toContain('setAgentAllowDangerousOperations');
    expect(settings).toContain('agentAllowDangerousOperations: false');
  });
});
