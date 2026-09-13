import type { AgentRuntimePersistenceRepository } from '../sqlite-repo/agent-runtime-persistence-repo';
import { loadCanonicalAgentChatProjection } from '../lib/agent/runtime/recovered-transcript';
import { createAgentRecoveryFixture } from './agent-recovery-fixture';
import { agentRecoveryWork, agentTranscriptWork, resetAgentTranscriptWork } from './agent-panel-counters';

export async function runAgentRecoveryScenarios() {
  const measurements = [];
  for (const turns of [100, 500, 1500]) {
    const fixture = createAgentRecoveryFixture(turns); const serialized = JSON.stringify(fixture);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    const fixtureHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const samplesMs = []; const work = []; let reads = 0;
    const repository = { loadRecoverySnapshot: async () => { reads++; return fixture.snapshot; } } as unknown as AgentRuntimePersistenceRepository;
    for (let repetition = 0; repetition < 3; repetition++) {
      resetAgentTranscriptWork(); for (const key of Object.keys(agentRecoveryWork) as Array<keyof typeof agentRecoveryWork>) agentRecoveryWork[key] = 0;
      const start = performance.now(); const projection = await loadCanonicalAgentChatProjection(fixture.snapshot.session.id, repository, fixture.visibleCache);
      samplesMs.push(performance.now() - start); work.push({ ...agentTranscriptWork, ...agentRecoveryWork });
      if (JSON.stringify(projection?.messages) !== JSON.stringify(fixture.expected)) throw new Error('Recovered display differs from independent fixture expectation');
      if (projection?.eventIds.join('\n') !== fixture.snapshot.events.map(row => row.eventId).join('\n')) throw new Error('Recovery lost represented event IDs');
      if (projection?.lastTerminal?.outcome !== 'completed' || projection.lastTerminal.turnId !== fixture.snapshot.turns[turns - 1].id || projection.latestContextUsage !== null) throw new Error('Recovery terminal/context changed');
    }
    if (JSON.stringify(fixture) !== serialized || reads !== 3) throw new Error('Recovery mutated input or reloaded the repository');
    measurements.push({ turns, events: fixture.snapshot.events.length, messages: fixture.expected.length, fixtureHash, samplesMs,
      medianMs: [...samplesMs].sort((a, b) => a - b)[1], work, checks: { independentDisplay: true, representedEvents: true, terminalAndContext: true, immutableInput: true, singleSnapshotRead: true } });
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  return { measurements, boundary: 'Synthetic complete text/thinking turns with preflight retries. Full strict recovery and display projection; repository returns an in-memory snapshot. No SQLite IO, checkpoints, tools, crash injection or fixed-device timing acceptance.' };
}
