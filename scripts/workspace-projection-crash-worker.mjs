import { createServer } from 'vite';

const server = await createServer({ configFile: false, logLevel: 'error', server: { middlewareMode: true, watch: null } });
try {
  const { runWorkspaceCrashWorker } = await server.ssrLoadModule('/src/renderer/services/acceptance/workspace-projection-crash.ts');
  await runWorkspaceCrashWorker(process.argv.slice(2));
} finally { await server.close(); }
