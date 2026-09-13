import { createServer } from 'vite';
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, entries: [] }, logLevel: 'error', server: { middlewareMode: true, watch: null } });
try {
  const { runAgentControlCrashWorker } = await server.ssrLoadModule('/src/renderer/performance/agent-control-crash-worker.ts');
  await runAgentControlCrashWorker(process.argv.slice(2));
} finally { await server.close(); }
