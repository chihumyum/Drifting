import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { AgentChatTranscript } from '../src/renderer/domain/agent-chat-transcript';
import type { AgentChatMessage } from '../src/renderer/domain/agent-conversation';
import { useAgentChatStore } from '../src/renderer/store/agent-chat-store';
import { createAgentChatJournalScope } from '../src/renderer/lib/agent/runtime/chat-journal-dedup';
import { createInactiveAgentAutomaticContinuation } from '../src/renderer/lib/agent/runtime/long-task-auto-continuation';
import { DesktopAgentTranscript } from '../src/renderer/features/agent/desktop/DesktopAgentTranscript';
import { MobileAgentTranscript } from '../src/renderer/shells/mobile/workspace/MobileAgentTranscript';
import { useDataStore } from '../src/renderer/store/data-store';
import { fmtTokens } from '../src/renderer/features/agent/AgentMessageViews';
import { WorkspaceNavigationProvider } from '../src/renderer/features/workspace/navigation/WorkspaceNavigationContext';
import '../src/styles/agent-panel.css';
import '../src/styles/mobile-workspace.css';

type Work = { arrays: number; flattenedRows: number; comparisons: number; leaves: number; classifiedRows: number; usageCandidates: number; evidenceCandidates: number; summaryBlocks: number };
const state = globalThis as typeof globalThis & { __TRANSCRIPT_SUMMARY_WORK__: Work; __TRANSCRIPT_SUMMARY__: { run(): Promise<unknown> } };
const zero = (): Work => ({ arrays: 0, flattenedRows: 0, comparisons: 0, leaves: 0, classifiedRows: 0, usageCandidates: 0, evidenceCandidates: 0, summaryBlocks: 0 });
state.__TRANSCRIPT_SUMMARY_WORK__ = zero();
state.__TRANSCRIPT_SUMMARY__ = { async run() {
  const before = useAgentChatStore.getState(); const dataBefore = useDataStore.getState(); const results = [];
  const i18n = createInstance(); await i18n.init({ lng: 'en', resources: {}, initImmediate: false });
  const host = document.createElement('div'); host.style.cssText = 'width:390px;height:640px;display:flex;flex-direction:column'; document.body.append(host);
  const root = createRoot(host); const projectId = 'synthetic-transcript-summary'; const conversationId = 'synthetic-conversation';
  try {
    for (const surface of ['desktop', 'mobile'] as const) for (const history of [300, 3000, 10000]) {
      const rows: AgentChatMessage[] = Array.from({ length: history }, (_, index) => index % 97 === 0
        ? { kind: 'usage', inputTokens: index + 1, outputTokens: index + 2, cacheReadTokens: 2, cacheCreationTokens: 3, costUsd: (index + 1) / 100000, turns: 1 }
        : index % 101 === 63 ? { kind: 'tool', id: `synthetic-tool-${index}`, name: 'read_node', input: { node: 'Synthetic Chapter' }, status: 'ok', result: 'Stable tool details.' }
        : { kind: 'assistant', text: `**History ${index}**\n\nSynthetic paragraph.`, streaming: false });
      rows.push({ kind: 'assistant', text: 'Tail', streaming: true });
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
      const fixtureSha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      let transcript = AgentChatTranscript.from(rows); const original = transcript; const opened: unknown[] = [];
      useDataStore.setState({ bookNodes: [{ id: 'synthetic-node-before', projectId, title: 'Synthetic Chapter', kind: 'chapter' } as never] });
      useAgentChatStore.setState({ boundProjectId: projectId, activeConvId: conversationId, starting: false, runningTurns: { [conversationId]: 'synthetic-turn' }, runs: { [conversationId]: {
        projectId, runtimeSessionId: null, transcript, journalScope: createAgentChatJournalScope(), controlStatus: 'running', pendingControl: null,
        lastTerminal: null, longTaskPlanState: null, contextUsage: null, automaticContinuation: createInactiveAgentAutomaticContinuation(),
      } } });
      flushSync(() => root.render(<I18nextProvider i18n={i18n}><WorkspaceNavigationProvider navigator={{ projectId, open(target) { opened.push(target); }, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} }}>
        {surface === 'desktop' ? <DesktopAgentTranscript /> : <MobileAgentTranscript projectId={projectId} conversationId={conversationId} />}
      </WorkspaceNavigationProvider></I18nextProvider>));
      const first = host.querySelector('.agent-md')!; const details = host.querySelector('details')!; details.open = true;
      const range = document.createRange(); range.setStart(first.querySelector('strong')!.firstChild!, 0); range.setEnd(first.querySelector('strong')!.firstChild!, 7);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      state.__TRANSCRIPT_SUMMARY_WORK__ = zero(); const updateMs = [];
      const publish = () => flushSync(() => useAgentChatStore.setState(value => ({ runs: { ...value.runs, [conversationId]: { ...value.runs[conversationId], transcript } } })));
      for (let update = 0; update < 20; update++) {
        transcript = transcript.replace(history, { kind: 'assistant', text: `Tail ${'word '.repeat(update + 1)}`, streaming: true });
        const start = performance.now(); publish(); updateMs.push(performance.now() - start);
      }
      const work = { ...state.__TRANSCRIPT_SUMMARY_WORK__ };
      const checks: Record<string, boolean> = {
        allHistoryMounted: host.querySelectorAll('.agent-md').length === rows.filter(row => row.kind === 'assistant').length,
        historyDomAndSelection: host.querySelector('.agent-md') === first && document.getSelection()?.toString() === 'History',
        toolDomAndExpansion: host.querySelector('details') === details && details.open,
        completeTail: host.textContent?.includes(`Tail ${'word '.repeat(20).trim()}`) === true,
        oldSnapshotUnchanged: original.at(history)?.kind === 'assistant' && (original.at(history) as { text: string }).text === 'Tail',
        canonicalEqualsExpected: JSON.stringify(transcript.toArray()) === JSON.stringify([...rows.slice(0, -1), { kind: 'assistant', text: `Tail ${'word '.repeat(20)}`, streaming: true }]),
      };
      // Exercise full rehydration and a historical tool update after the measured tail-only work.
      transcript = AgentChatTranscript.from(transcript.toArray()); publish();
      checks.rebuiltLeavesPreserveDom = host.querySelector('.agent-md') === first && host.querySelector('details') === details && details.open;
      transcript = transcript.replace(63, { kind: 'tool', id: 'synthetic-tool-63', name: 'read_node', input: { node: 'Synthetic Chapter' }, status: 'ok', result: 'Changed historical tool.' }); publish();
      checks.historicalToolUpdated = host.textContent?.includes('Changed historical tool.') === true && host.querySelector('details') === details && details.open;
      transcript = transcript.replace(history, { kind: 'assistant', text: 'Final answer', streaming: false }).append({ kind: 'usage', inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.001, turns: 1, durationMs: 100 });
      flushSync(() => useAgentChatStore.setState(value => ({ runningTurns: {}, runs: { ...value.runs, [conversationId]: { ...value.runs[conversationId], transcript, controlStatus: null } } })));
      const expectedUsage = { inTok: 0, outTok: 0, cost: 0, tools: 0 };
      for (const row of transcript) {
        if (row.kind === 'usage') { expectedUsage.inTok += row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens; expectedUsage.outTok += row.outputTokens; expectedUsage.cost += row.costUsd; }
        else if (row.kind === 'tool') expectedUsage.tools++;
      }
      const usageFooter = surface === 'desktop' ? host.querySelector('[title="agentPanel.usage.sessionTitle"]')?.textContent : null;
      if (surface === 'mobile') {
        (host.querySelector('.m-agent-evidence button') as HTMLButtonElement).click();
        useDataStore.setState({ bookNodes: [{ id: 'synthetic-node-after', projectId, title: 'Synthetic Chapter', kind: 'chapter' } as never] });
        transcript = transcript.replace(history, { kind: 'assistant', text: 'Final answer after workspace change', streaming: false }); publish();
        (host.querySelector('.m-agent-evidence button') as HTMLButtonElement).click();
      }
      checks.currentEvidenceTarget = surface === 'desktop' || JSON.stringify(opened) === JSON.stringify([{ entityType: 'node', id: 'synthetic-node-before' }, { entityType: 'node', id: 'synthetic-node-after' }]);
      checks.terminalAndUsagePresent = host.textContent?.includes('Final answer') === true && (surface === 'mobile' ? host.querySelectorAll('.m-agent-output-actions').length > 0 : host.textContent?.includes(`↑${fmtTokens(expectedUsage.inTok)} ↓${fmtTokens(expectedUsage.outTok)}`) === true);
      if (Object.values(checks).some(value => !value)) throw new Error(JSON.stringify({ surface, history, checks }));
      results.push({ surface, history, updates: 20, fixtureSha256, work, updateMs, expectedUsage, usageFooter, checks });
      document.getSelection()?.removeAllRanges(); flushSync(() => root.render(null));
    }
    return results;
  } finally { document.getSelection()?.removeAllRanges(); flushSync(() => root.unmount()); host.remove(); useAgentChatStore.setState(before, true); useDataStore.setState(dataBefore, true); }
} };
