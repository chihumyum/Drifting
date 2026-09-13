import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BlockId } from '../lib/extensions/block-id';
import { registerCopilotCapability, type CapabilityDetectContext, type CapabilityDetectResult } from '../lib/copilot/capability';
import { useCopilot } from '../hooks/useCopilot';
import { useSettingsStore } from '../store/settings-store';
import { events, type AiTaskEvent } from '../lib/events';
import { copilotRunCalls, deferred } from './copilot-run-services';

export async function runCopilotRunScenarios() {
  const host = document.createElement('div'); const prose = document.createElement('div'); document.body.append(host, prose);
  const root = createRoot(host); const editor = new Editor({ element: prose, extensions: [StarterKit, BlockId], content: '<p>Synthetic owned capability.</p>' });
  const originalSettings = useSettingsStore.getState();
  useSettingsStore.setState({ copilotAutoTrigger: false, copilotGenerateSummaries: false });
  const detections: Array<CapabilityDetectContext & ReturnType<typeof deferred<CapabilityDetectResult[]>>> = [];
  const tasks: AiTaskEvent[] = [];
  const onTask = (event: AiTaskEvent) => { if (event.id.startsWith('copilot:synthetic-owned-capability:')) tasks.push(event); };
  events.on('ai-task', onTask);
  const initialListeners = events.all.get('copilot:manual-run')?.length ?? 0;
  registerCopilotCapability({ id: 'synthetic-owned-capability', metadataKind: 'element-candidate', displayName: 'Synthetic capability', description: 'Isolated lifetime check', trigger: 'manual', defaultDebounceMs: 250,
    detect: input => { const call = { ...input, ...deferred<CapabilityDetectResult[]>() }; detections.push(call); return call.promise; },
    accept: async () => { throw new Error('Acceptance must not accept synthetic suggestions'); },
  });
  const checks: string[] = [];
  const check = (name: string, valid: unknown) => { if (!valid) throw new Error(`Copilot run: ${name}`); checks.push(name); };
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const context = () => ({ chapterId: 'synthetic-run-node', uncoveredBlocks: [{ blockId: editor.state.doc.firstChild!.attrs.id as string, text: 'Synthetic owned capability.', offset: 0 }], priorSections: [], mentionedElementIds: [] });
  function Mount({ projectId }: { projectId: string }) { useCopilot({ editor, projectId, nodeId: 'synthetic-run-node', userId: 'synthetic-user' }); return null; }
  const render = (visible: boolean, projectId = 'synthetic-run-project') => flushSync(() => root.render(visible ? createElement(Mount, { projectId }) : null));
  const invoke = () => events.emit('copilot:manual-run', { nodeId: 'synthetic-run-node', capId: 'synthetic-owned-capability' });
  const last = <T,>(items: T[]) => items[items.length - 1]!;
  const prepare = () => { invoke(); return last(copilotRunCalls.contexts); };
  const beginDetection = async () => { prepare().resolve(context()); await settle(); return last(detections); };
  const suggestion: CapabilityDetectResult = { anchorJson: '{}', metadata: { kind: 'element-candidate', suggestedName: 'Synthetic', suggestedCategoryHint: 'Synthetic category', evidenceText: 'Synthetic', confidence: 1, promptId: 'synthetic', promptVersion: 1, model: 'synthetic' } };
  try {
    render(true); await settle(); invoke(); check('context preparation is controlled', copilotRunCalls.contexts.length === 1);
    render(false); await settle(); copilotRunCalls.contexts[0].resolve(context()); await settle();
    check('unmount during context preparation does not start an orphaned capability', detections.length === 0);

    render(true); const older = prepare(); const newer = prepare(); newer.resolve(context()); await settle();
    const first = last(detections); older.resolve(context()); await settle();
    check('out-of-order context completion cannot replace the latest capability', detections.length === 1 && !first.signal.aborted);
    const replacement = prepare(); check('replacement aborts detection before waiting for new context', first.signal.aborted);
    replacement.resolve(context()); await settle(); const second = last(detections);
    first.resolve([suggestion]); await settle();
    check('late aborted detection cannot write or cancel its replacement', copilotRunCalls.writes.length === 0 && !second.signal.aborted);
    second.resolve([]); await settle();
    check('manual task replacement ends each started task exactly once', tasks.filter(task => task.state === 'started').length === 2 && tasks.filter(task => task.state === 'stopped').length === 1 && tasks.filter(task => task.state === 'completed').length === 1);

    const detached = await beginDetection(); render(false); detached.resolve([suggestion]); await settle();
    check('unmount aborts an active detector and suppresses its late suggestions', detached.signal.aborted && copilotRunCalls.writes.length === 0);
    render(true); const readonly = await beginDetection(); editor.setEditable(false); editor.setEditable(true); readonly.resolve([suggestion]); await settle();
    check('readonly return cannot revive a retired invocation', readonly.signal.aborted && copilotRunCalls.writes.length === 0);
    render(false); render(true); const previousSettings = prepare(); const beforeSettings = detections.length;
    flushSync(() => useSettingsStore.setState({ copilotSummarySectionSize: originalSettings.copilotSummarySectionSize + 1 }));
    previousSettings.resolve(context()); await settle();
    check('settings rebind invalidates the previous effect context preparation', detections.length === beforeSettings);
    const previousProject = prepare(); const beforeProject = detections.length;
    render(true, 'synthetic-next-project'); previousProject.resolve(context()); await settle();
    check('project replacement invalidates pending old-project context', detections.length === beforeProject);
    const incoming = await beginDetection(); check('incoming project owns the current capability', incoming.projectId === 'synthetic-next-project'); incoming.resolve([suggestion]); await settle();
    check('current suggestions retain their authored anchor and write normally', copilotRunCalls.writes.length === 1 && copilotRunCalls.writes[0].targetBlockId === editor.state.doc.firstChild!.attrs.id);
    const blockedWrite = deferred<void>(); copilotRunCalls.blockedWrite = blockedWrite;
    (await beginDetection()).resolve([suggestion, suggestion]); await settle(); render(false); blockedWrite.resolve(); await settle();
    check('already-started persistence finishes without launching remaining writes after closure', copilotRunCalls.writes.length === 2);
    copilotRunCalls.blockedWrite = null; render(true);

    flushSync(() => useSettingsStore.setState({ copilotGenerateSummaries: true, copilotSummarySectionSize: 1 }));
    const summarized = await beginDetection(); summarized.resolve([]); await settle();
    const firstSummary = last(copilotRunCalls.summaries);
    check('summary remains owned after its detector completes', copilotRunCalls.summaries.length === 1 && !firstSummary.signal?.aborted);
    render(false); check('unmount aborts the outstanding summary', firstSummary.signal?.aborted);
    render(true); (await beginDetection()).resolve([]); await settle();
    const secondSummary = last(copilotRunCalls.summaries);
    firstSummary.resolve(); await settle(); (await beginDetection()).resolve([]); await settle();
    check('late old summary completion cannot release a new owner summary lock', copilotRunCalls.summaries.length === 2 && !secondSummary.signal?.aborted);
    secondSummary.resolve(); await settle(); (await beginDetection()).resolve([]); await settle();
    check('current summary completion permits the next summary', copilotRunCalls.summaries.length === 3);
    render(false);
    for (let cycle = 0; cycle < 100; cycle++) {
      render(true); if (events.all.get('copilot:manual-run')?.length !== initialListeners + 1) throw new Error(`Cycle ${cycle} duplicated the manual command owner`);
      render(false);
    }
    check('closed owners release every manual command listener', (events.all.get('copilot:manual-run')?.length ?? 0) === initialListeners);
    render(true); const destroyed = await beginDetection(); editor.destroy(); destroyed.resolve([suggestion]); await settle(); render(false);
    check('editor destruction aborts outstanding detection before late persistence', destroyed.signal.aborted && copilotRunCalls.writes.length === 2);
    const started = tasks.filter(task => task.state === 'started');
    check('task IDs do not repeat after remount or settings rebind', new Set(started.map(task => task.id)).size === started.length);
    check('every announced task has exactly one terminal event', started.every(start => tasks.filter(task => task.id === start.id && task.state !== 'started').length === 1));
    return { checks, cycles: 100, detections: detections.length, writes: copilotRunCalls.writes.length, summaries: copilotRunCalls.summaries.length,
      remainingManualListeners: (events.all.get('copilot:manual-run')?.length ?? 0) - initialListeners,
      scope: 'Actual React hook and Tiptap editor with deferred synthetic services; no model or SQLite calls.' };
  } finally {
    flushSync(() => root.unmount()); if (!editor.isDestroyed) editor.destroy(); host.remove(); prose.remove();
    events.off('ai-task', onTask);
    useSettingsStore.setState({ copilotAutoTrigger: originalSettings.copilotAutoTrigger, copilotGenerateSummaries: originalSettings.copilotGenerateSummaries, copilotSummarySectionSize: originalSettings.copilotSummarySectionSize });
    detections.forEach(call => call.resolve([]));
    copilotRunCalls.blockedWrite?.resolve(); copilotRunCalls.blockedWrite = null;
    copilotRunCalls.summaries.forEach(call => call.resolve());
  }
}
