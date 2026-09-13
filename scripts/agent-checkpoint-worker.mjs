import { createServer } from 'vite';
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, entries: [] }, logLevel: 'error', server: { middlewareMode: true, watch: null } });
try {
  const { runAgentCheckpointWorker } = await server.ssrLoadModule('/src/renderer/performance/agent-checkpoint-worker.ts');
  await runAgentCheckpointWorker(process.argv.slice(2));
} finally { await server.close(); }
