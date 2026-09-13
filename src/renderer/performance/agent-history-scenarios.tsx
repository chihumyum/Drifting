import { AgentChatTranscript } from '../domain/agent-chat-transcript';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { DesktopAgentTranscript } from '../features/agent/desktop/DesktopAgentTranscript';
import { MobileAgentTranscript } from '../shells/mobile/workspace/MobileAgentTranscript';
import { WorkspaceNavigationProvider } from '../features/workspace/navigation/WorkspaceNavigationContext';
import { useAgentChatStore } from '../store/agent-chat-store';
import { createAgentChatJournalScope } from '../lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../lib/agent/runtime/long-task-auto-continuation';
import type { AgentChatMessage } from '../domain/agent-conversation';
import { agentHistoryWork } from './agent-panel-counters';
import mobileCss from '../../styles/mobile-workspace.css?inline';

/** Force complete display commits to measure reconciliation, independently of
 * event deduplication, rAF batching, persistence, or model/network latency. */
export async function runAgentHistoryScenarios({ measure = true } = {}) {
  const before = useAgentChatStore.getState();
  const i18n = createInstance(); await i18n.init({ lng: 'en', resources: {}, initImmediate: false });
  const host = document.createElement('div'); host.style.cssText = 'width:390px;height:640px;display:flex;flex-direction:column'; document.body.append(host);
  const style = document.createElement('style'); style.textContent = mobileCss; document.head.append(style);
  const root = createRoot(host); const projectId = 'synthetic-history-project'; const conversationId = 'synthetic-history-conversation';
  const measurements = [];
  try {
    for (const surface of ['desktop', 'mobile'] as const) for (const historyMessages of [300, 3_000]) {
      let messages: AgentChatMessage[] = Array.from({ length: historyMessages }, (_, index) => index === 63
        ? { kind: 'tool', id: 'synthetic-history-tool', name: 'synthetic_inspect', status: 'ok', result: 'Stable tool details.' }
        : { kind: 'assistant', text: `**History ${index}**\n\nStable synthetic paragraph.`, streaming: false });
      messages.push({ kind: 'assistant', text: 'Current tail.', streaming: true });
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(messages)));
      const fixtureHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      useAgentChatStore.setState({ boundProjectId: projectId, activeConvId: conversationId, starting: false, runningTurns: { [conversationId]: 'synthetic-turn' },
        runs: { [conversationId]: { projectId, runtimeSessionId: null, transcript: AgentChatTranscript.from(messages), journalScope: createAgentChatJournalScope(), controlStatus: 'running', pendingControl: null,
          lastTerminal: null, longTaskPlanState: null, contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation() } } });
      flushSync(() => root.render(<I18nextProvider i18n={i18n}><WorkspaceNavigationProvider navigator={{ projectId, open() {}, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} }}>
        {surface === 'desktop' ? <DesktopAgentTranscript /> : <MobileAgentTranscript projectId={projectId} conversationId={conversationId} />}
      </WorkspaceNavigationProvider></I18nextProvider>));
      const first = host.querySelector('.agent-md')!; const details = host.querySelector('details')!; details.open = true;
      const text = first.querySelector('strong')!.firstChild!; const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 7);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      agentHistoryWork.rowElements = 0; const updateMs = [];
      for (let update = 0; update < 20; update++) {
        messages = [...messages.slice(0, -1), { kind: 'assistant', text: `Current tail. ${'word '.repeat(update + 1)}`, streaming: true }];
        const transcript = AgentChatTranscript.from(messages);
        const start = performance.now();
        flushSync(() => useAgentChatStore.setState(state => ({ runs: { ...state.runs, [conversationId]: { ...state.runs[conversationId], transcript } } })));
        updateMs.push(performance.now() - start);
      }
      const checks = [
        { id: 'all-history-stays-mounted', passed: host.querySelectorAll('.agent-md').length === historyMessages },
        { id: 'historical-dom-and-selection-retained', passed: host.querySelector('.agent-md') === first && document.getSelection()?.toString() === 'History' },
        { id: 'tool-detail-dom-and-expansion-retained', passed: host.querySelector('details') === details && details.open },
        { id: 'latest-text-complete', passed: host.textContent?.includes(`Current tail. ${'word '.repeat(20).trim()}`) === true },
      ];
      if (checks.some(check => !check.passed)) throw new Error(`Agent history ${surface}: ${JSON.stringify(checks)}`);
      const sorted = [...updateMs].sort((a, b) => a - b);
      measurements.push({ surface, historyMessages, fixtureHash, displayUpdates: 20, rowElements: measure ? agentHistoryWork.rowElements : null, updateMs: measure ? updateMs : null, medianMs: measure ? sorted[10] : null, p95Ms: measure ? sorted[18] : null, checks });
      document.getSelection()?.removeAllRanges(); flushSync(() => root.render(null));
    }
    return { implementation: 'stable-message-blocks', measure, measurements, boundary: 'Actual desktop/mobile transcripts with every historical DOM row retained; synchronous full display commits. Source arrays prepared outside timing; no canonical journal ingestion, model, persistence or native input.' };
  } finally { document.getSelection()?.removeAllRanges(); flushSync(() => root.unmount()); host.remove(); style.remove(); useAgentChatStore.setState(before, true); }
}
