import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('General Agent desktop handoff affordance', () => {
  it('prepares a visible author prompt from a fresh chat without auto-sending it', () => {
    const panel = source('src/renderer/features/agent/desktop/DesktopAgentPanel.tsx');
    const handler = panel.slice(
      panel.indexOf('const handlePrepareHandoff'),
      panel.indexOf('const handleLoad'),
    );
    const en = JSON.parse(source('src/renderer/locales/en.json')) as Record<string, unknown>;
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json')) as Record<string, unknown>;

    expect(panel).toContain('readAgentProjectHandoff({ projectId })');
    expect(panel).toContain('activeConvId === null && handoffTask');
    expect(handler).toContain("setPrompt(\n      t('agentPanel.handoff.prompt'");
    expect(handler).not.toContain('start(');
    expect(handler).not.toContain('send');
    expect((en.agentPanel as { handoff?: unknown }).handoff).toBeDefined();
    expect((zh.agentPanel as { handoff?: unknown }).handoff).toBeDefined();
  });

  it('uses a wash treatment with keyboard focus and makes no mobile Agent UI claim', () => {
    const styles = source('src/styles/agent-panel.css');
    const handoffStyles = styles.slice(
      styles.indexOf('.agt-handoff-card'),
      styles.indexOf('.agt-composer'),
    );
    const mobileShell = source('src/renderer/shells/mobile/MobileAppShell.tsx');

    expect(handoffStyles).toContain('background: hsl(var(--accent) / 0.07)');
    expect(handoffStyles).toContain('.agt-handoff-card button:focus-visible');
    expect(handoffStyles).not.toContain('border-left');
    expect(mobileShell).not.toContain('readAgentProjectHandoff');
    expect(mobileShell).not.toContain('agt-handoff-card');
  });
});
