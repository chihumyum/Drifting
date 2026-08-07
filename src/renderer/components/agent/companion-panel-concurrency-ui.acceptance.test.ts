import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('General Agent sibling-conversation activity UI', () => {
  it('keeps the idle sibling composer clear while retaining history-row indicators', () => {
    const panel = source('src/renderer/components/agent/CompanionPanel.tsx');
    const en = JSON.parse(source('src/renderer/locales/en.json'));
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json'));

    expect(panel).toContain('{runningTurns[c.id] &&');
    expect(panel).toContain('className="agt-history__running-dot"');
    expect(panel).not.toContain('className="agt-otherrun"');
    expect(panel).not.toContain('selectOtherRunningConversationId');
    expect(panel).not.toContain("t('agentPanel.running.");
    expect(en.agentPanel.running).toBeUndefined();
    expect(zh.agentPanel.running).toBeUndefined();
  });

  it('records the composer boundary in the concurrency acceptance document', () => {
    const acceptance = source(
      'docs/agent-runtime/acceptance/CONCURRENT_AGENT_SESSIONS_ACCEPTANCE_2026-08-05.md',
    );

    expect(acceptance).toContain('no cross-conversation working banner is inserted');
  });
});
