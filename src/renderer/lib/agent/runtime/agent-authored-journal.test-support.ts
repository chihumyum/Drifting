import { createAgentAuthoredJournal, type AgentAuthoredJournal } from './agent-authored-journal';

function protocolToken(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+/u, '');
  return normalized || 'agent-test';
}

/** Deterministic native-identity substitute for Node SQLite integration tests. */
export function createTestAgentAuthoredJournal(label: string): AgentAuthoredJournal {
  const token = protocolToken(label);
  let writer = 0;
  let generation = 0;
  let projectSync = 0;
  return createAgentAuthoredJournal({
    identity: async () => ({
      installationId: `install-${token}`,
      createWriterIdentity: () => {
        writer += 1;
        return {
          writerId: `writer-${token}-${writer}`,
          writerEpoch: `epoch-${token}-${writer}`,
        };
      },
    }),
    syncGenerationIds: {
      createSyncGenerationId: () => `sync-generation-${token}-${++generation}`,
      createProjectSyncId: () => `project-sync-${token}-${++projectSync}`,
    },
  });
}
