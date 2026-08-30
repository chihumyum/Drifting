import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(import.meta.dirname, '../../..');
const repoRoot = path.resolve(rendererRoot, '../..');
const source = (relative: string) => fs.readFileSync(path.join(rendererRoot, relative), 'utf8');

describe('Mobile V2 M6 Agent, Library/TODO, and Stats acceptance wiring', () => {
  it('mounts a mobile-owned answer-only Agent over the shared durable runtime', () => {
    const panels = source('shells/mobile/workspace/MobileRightSidebar.tsx');
    const agent = source('shells/mobile/workspace/MobileAgentPanel.tsx');
    const store = source('store/agent-chat-store.ts');
    const conversation = source('domain/agent-conversation.ts');
    const runtime = source('lib/agent/runtime/runtime.ts');

    expect(panels).toContain("import { MobileAgentPanel } from './MobileAgentPanel'");
    expect(panels).toContain('<MobileAgentPanel projectId={projectId} target={target} />');
    expect(panels).not.toMatch(/DesktopAgent|DesktopRightSidebar/);
    expect(agent).toContain("send({ turnContext, toolAccess: 'read_only' })");
    expect(agent).toContain("send({ turnContext: previous.context ?? turnContext, toolAccess: 'read_only' })");
    expect(agent).not.toContain('writeChapterProse');
    expect(agent).not.toContain('continueTask');
    expect(store).toContain('turnContext?: readonly AgentConversationContextRef[]');
    expect(store).toContain('context: turnContext');
    expect(store).toContain("toolAccess === 'read_only'");
    expect(store).toContain(
      'createInactiveAgentAutomaticContinuation(previousAutomatic.sequenceId + 1)',
    );
    expect(conversation).toContain('context?: AgentConversationContextRef[]');
    expect(runtime).toContain(
      ".filter((definition) => toolAccess === 'read_write' || definition.access === 'read')",
    );
  });

  it('persists visible context and keeps evidence/output changes behind author taps', () => {
    const agent = source('shells/mobile/workspace/MobileAgentPanel.tsx');
    const model = source('shells/mobile/workspace/mobile-agent-model.ts');
    const context = source('lib/agent/turn-context.ts');

    expect(agent).toContain('<ContextChips refs={turnContext} />');
    expect(agent).toContain('collectMobileAgentEvidence(messages)');
    expect(agent).toContain('openMobileAgentEvidence(item');
    expect(agent).toContain("action: 'copy' | 'inspiration' | 'todo'");
    expect(agent).toContain("kind: 'drift'");
    expect(agent).toContain("kind: 'todo'");
    expect(model).toContain('selectedMobileAgentBlockId');
    expect(model).toContain('targetBlockId: target.blockId');
    expect(model).toContain('scrollToBlock(evidence.entityId, evidence.blockId)');
    expect(context).toContain('normalizeAgentTurnContext');
    expect(context).toContain('agentTurnContextPrompt');
  });

  it('reflows complete Library/TODO semantics with ordinary mobile action targets', () => {
    const panels = source('shells/mobile/workspace/MobileRightSidebar.tsx');
    const library = source('features/library/LibraryPanel.tsx');
    const card = source('features/library/LibraryItemCard.tsx');
    const dialogs = source('features/library/LibraryDialogs.tsx');
    const footer = source('components/ui/CollapsibleFooter.tsx');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    expect(panels).toContain('<ReviewPanel focused={focused} />');
    expect(panels).toContain('<LibraryPanel focused={focused} presentation="mobile" />');
    expect(library).toContain("mobileActions={presentation === 'mobile'}");
    expect(card).toContain('className="library-item-card__mobile-menu"');
    expect(card).toContain("data-library-mobile-actions={mobileActions ? 'true' : undefined}");
    expect(dialogs).toContain('resolved-todo-archive__action');
    expect(footer).toContain('className="collapsible-footer__toggle"');
    expect(css).toContain(".btl-cmenu[data-library-mobile-actions='true'] .menu-surface__item");
    expect(css).toContain('.m-library-workspace .resolved-todo-archive__action');
    expect(css).toContain('min-height: 44px');
  });

  it('reuses desktop-right-sidebar Stats in a draggable entity-owned Sheet', () => {
    const panels = source('shells/mobile/workspace/MobileRightSidebar.tsx');
    const statsSheet = source('shells/mobile/workspace/MobilePaperStatsSheet.tsx');
    const css = fs.readFileSync(path.join(repoRoot, 'src/styles/mobile-workspace.css'), 'utf8');

    expect(panels).not.toContain("| 'stats'");
    expect(panels).not.toContain('<EntityStatsContent');
    expect(statsSheet).toContain("from '../../../features/stats/EntityStatsContent'");
    expect(statsSheet).toContain('<EntityStatsContent');
    expect(statsSheet).toContain('setPointerCapture');
    expect(statsSheet).toContain('offset >= 96 || velocity >= 0.75');
    expect(css).toContain('.m-paper-stats-sheet__grab');
    expect(css).toContain('.m-paper-stats-sheet__content [role=\'button\']');
  });
});
