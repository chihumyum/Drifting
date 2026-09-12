import { createServer } from 'vite';

// Only native installation identity is substituted. The authored transaction,
// journal, SQL gateway adapter, repositories and project service are real.
const server = await createServer({
  configFile: false, logLevel: 'error',
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: 'synthetic-reference-crash-identity',
    enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('/installation-identity')) return '\0synthetic-reference-identity';
    },
    load(id) {
      if (id === '\0synthetic-reference-identity') return `
        export async function getSyncInstallationIdentity() {
          return { installationId: 'synthetic-reference-install',
            createWriterIdentity: () => ({ writerId: 'synthetic-reference-writer', writerEpoch: 'synthetic-reference-epoch' }) };
        }`;
    },
  }],
});
try {
  const { runReferenceCrashWorker } = await server.ssrLoadModule('/src/renderer/services/acceptance/reference-index-crash.ts');
  await runReferenceCrashWorker(process.argv.slice(2));
} finally {
  await server.close();
}
