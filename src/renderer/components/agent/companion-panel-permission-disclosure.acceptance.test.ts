import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('General Agent permission disclosure', () => {
  it('shows a natural domain action before a collapsed raw-argument disclosure', () => {
    const panel = source('src/renderer/features/agent/AgentMessageViews.tsx');
    const naturalDescription = panel.indexOf('describeAgentPermissionAction(');
    const rawDisclosure = panel.indexOf(
      "<summary>{t('agentPanel.control.arguments')}</summary>",
    );

    expect(naturalDescription).toBeGreaterThan(-1);
    expect(rawDisclosure).toBeGreaterThan(naturalDescription);
    expect(panel.slice(rawDisclosure - 20, rawDisclosure)).toContain('<details>');
    expect(panel).not.toContain('EditFilePermissionPreview');
  });

  it('offers no switch for destructive operations, which run without asking', () => {
    const panel = source('src/renderer/features/agent/AgentComposerConfig.tsx');
    const policy = source('src/renderer/lib/agent/runtime/drifting-permission-policy.ts');

    expect(panel).not.toMatch(/dangerous/i);
    expect(policy).not.toMatch(/allowDangerousOperations|decision: 'ask'/);
  });
});
