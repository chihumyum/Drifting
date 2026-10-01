/** Synthetic conversations rendered through the real desktop Agent panels. */
import { DesktopAgentPanel } from '../src/renderer/features/agent/desktop/DesktopAgentPanel';
import { SidebarPaneContext } from '../src/renderer/lib/sidebar-pane-context';
import { WorkspaceNavigationProvider } from '../src/renderer/features/workspace/navigation/WorkspaceNavigationContext';
import { useAgentChatStore } from '../src/renderer/store/agent-chat-store';
import { AgentChatTranscript } from '../src/renderer/domain/agent-chat-transcript';
import { createAgentChatJournalScope } from '../src/renderer/lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../src/renderer/lib/agent/runtime/long-task-auto-continuation';
import { installGeneralAgentTransport, unsupportedGeneralAgentTransport } from '../src/renderer/lib/agent/transport';

const projectId = 'synthetic-typography-project';
const draft = '这是需要自动换行的合成输入草稿。调整界面字号时，它应当完整显示并自动调整高度。';
const transcript = AgentChatTranscript.from([
  { kind: 'user', text: '合成用户消息：请检查这段长文字在两个独立面板中的排版。', at: '2026-10-01T12:00:00.000Z' },
  { kind: 'thinking', text: '合成思考内容：检查字号变化和文本换行。', streaming: true },
  { kind: 'tool', id: 'synthetic-tool', name: 'synthetic_read', status: 'ok', input: { text: 'Synthetic input' }, result: 'Synthetic output' },
  { kind: 'assistant', text: '### 合成标题\n\n合成回复正文，在字号调整后自然换行。This synthetic answer shares the UI text setting.\n\n行内代码 `synthetic_code()`。\n\n```text\n' + 'synthetic_long_code_'.repeat(32) + '\n```' },
  { kind: 'usage', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.001, turns: 1 },
]);
const run = () => ({ projectId, transcript, runtimeSessionId: null, journalScope: createAgentChatJournalScope(),
  controlStatus: null, pendingControl: null, lastTerminal: null, longTaskPlanState: null, contextUsage: null,
  automaticContinuation: createInactiveAgentAutomaticContinuation() });
installGeneralAgentTransport({ ...unsupportedGeneralAgentTransport,
  capability: { available: true, kind: 'local' },
  authStatus: async () => ({ ok: true, value: { byokConnected: true, apiKeyConnected: true, hostedAvailable: true } }),
  subscribeJournal: () => ({ ok: true, value: () => undefined }),
});
useAgentChatStore.setState({ ...useAgentChatStore.getInitialState(), boundProjectId: projectId, activeConvId: 'synthetic-A', prompt: draft,
  runs: { 'synthetic-A': run(), 'synthetic-B': run() }, refreshList: () => undefined,
  viewBindings: { 'sidebar:primary': 'default', 'sidebar:secondary': 'sidebar:secondary' },
  views: { 'sidebar:secondary': { activeConvId: 'synthetic-B', prompt: draft, starting: false } },
});

export function AgentTypographyFixture() {
  return <WorkspaceNavigationProvider navigator={{ projectId, open() {}, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} }}>
    <div id="agent-typography" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', maxWidth: 800, margin: '24px 0' }}>
      {(['primary', 'secondary'] as const).map(id => <div key={id} data-agent-typography-pane={id} style={{ height: 650, minWidth: 0, border: '1px solid hsl(var(--rule))' }}>
        <SidebarPaneContext.Provider value={id}><DesktopAgentPanel projectId={projectId} /></SidebarPaneContext.Provider>
      </div>)}
    </div>
  </WorkspaceNavigationProvider>;
}

export function measureAgentTypography(size: 'small' | 'standard' | 'large') {
  const expected = { small: [12, 11.5, 10.5, 13.5], standard: [14, 13, 12, 16], large: [16, 15, 14, 18] }[size];
  const panes = [...document.querySelectorAll<HTMLElement>('[data-agent-typography-pane]')];
  const samples = panes.map(pane => {
    const find = (selector: string) => pane.querySelector<HTMLElement>(selector)!;
    const font = (node: Element) => parseFloat(getComputedStyle(node).fontSize);
    const body = find('.agent-md p'), code = find('.agent-md pre'), composer = find('textarea');
    const probe = composer.cloneNode(true) as HTMLTextAreaElement;
    probe.style.cssText += `position:absolute;visibility:hidden;width:${composer.getBoundingClientRect().width}px;height:auto;`;
    probe.value = (composer as HTMLTextAreaElement).value;
    composer.parentElement!.append(probe);
    const naturalHeight = Math.min(parseFloat(getComputedStyle(probe).maxHeight), probe.scrollHeight);
    probe.remove();
    const thinking = [...pane.querySelectorAll('details')].find(detail => detail.querySelector('summary')?.textContent?.includes('💭'))!;
    return { body: font(body), user: font(find('time').previousElementSibling!), composer: font(composer),
      thinking: font(thinking.querySelector('div')!), tool: font(find('summary code')), caption: font(find('time')),
      heading: font(find('.agent-md h3')), code: font(find('.agent-md pre code')), inlineCode: font(find('.agent-md p code')),
      lineHeight: parseFloat(getComputedStyle(body).lineHeight), composerLineHeight: parseFloat(getComputedStyle(composer).lineHeight),
      codeScrolls: code.scrollWidth > code.clientWidth && ['auto', 'scroll'].includes(getComputedStyle(code).overflowX),
      fits: pane.scrollWidth <= pane.clientWidth + 1,
      composerFits: composer.scrollHeight <= composer.clientHeight + 1,
      composerResizes: Math.abs(composer.clientHeight - naturalHeight) <= 1,
    };
  });
  return { samples, passed: samples.length === 2 && samples.every(s =>
    [s.body, s.user, s.composer, s.code, s.inlineCode].every(value => value === expected[0])
    && s.thinking === expected[1] && s.tool === expected[1] && s.caption === expected[2] && s.heading === expected[3]
    && Math.abs(s.lineHeight - expected[0] * 1.4) < 0.1 && Math.abs(s.composerLineHeight - expected[0] * 1.4) < 0.1
    && s.codeScrolls && s.fits && s.composerFits && s.composerResizes) };
}
