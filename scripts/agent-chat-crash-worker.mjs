import { createServer } from 'vite';

const server = await createServer({ configFile: false, logLevel: 'error', server: { middlewareMode: true, watch: null } });
try {
  const { runAgentChatCrashWorker } = await server.ssrLoadModule('/src/renderer/performance/agent-chat-crash-worker.ts');
  await runAgentChatCrashWorker(process.argv.slice(2));
} finally { await server.close(); }
