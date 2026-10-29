// Opt-in, loopback-only Vite instrumentation. Never included in product builds.
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function nativePerformanceAuditPlugin({ directory, origin }) {
  const token = randomBytes(24).toString('hex');
  const endpoint = '/__drifting_performance_audit__';
  let marker = 'startup';
  let latest = null;
  let samples = 0;
  let root = process.cwd();
  return {
    name: 'native-performance-audit', apply: 'serve', enforce: 'pre',
    config() { return { optimizeDeps: { exclude: ['@tauri-apps/api/core'] } }; },
    configResolved(config) { root = config.root; },
    transform(code, id) {
      const file = id.split('?')[0];
      if (file.endsWith('/src/renderer/main.tsx')) {
        const anchor = '<StrictMode>';
        if (code.split(anchor).length !== 2) throw new Error('Audit root Profiler anchor drifted');
        return `import '/scripts/native-performance-audit-probe';\nimport { Profiler as AuditProfiler } from 'react';\n${code}`
          .replace('<StrictMode>', '<AuditProfiler id="app" onRender={(...args) => window.__DRIFTING_PERFORMANCE_AUDIT_COMMIT__?.(...args)}><StrictMode>')
          .replace('</StrictMode>', '</StrictMode></AuditProfiler>');
      }
      const names = ['ChapterPanel', 'ElementPanel', 'DriftPanel', 'DesktopAgentPanel', 'DesktopAgentTranscript', 'DesktopSuperMemoMaterialView', 'DesktopStoryGraphView', 'DesktopSuperElementView'];
      const name = names.find(name => file.endsWith(`/${name}.tsx`));
      if (!name) return null;
      const entry = code.indexOf(`function ${name}(`);
      const anchor = '  const { t } = useTranslation();';
      const at = code.indexOf(anchor, entry);
      if (entry < 0 || at < 0) throw new Error(`Audit render counter anchor drifted: ${name}`);
      return code.slice(0, at) + code.slice(at).replace(anchor, `${anchor}\n  window.__DRIFTING_PERFORMANCE_AUDIT_RENDER__?.(${JSON.stringify(name)});`);
    },
    // ReactDOM's imports execute before main's body. The probe must be a
    // dependency with a side effect, rather than just a main-body invocation.
    resolveId(id) {
      if (id === '/scripts/native-performance-audit-probe') return '\0native-performance-audit-probe';
      if (id === '@tauri-apps/api/core') return '\0native-performance-audit-tauri-core';
    },
    load(id) {
      if (id === '\0native-performance-audit-tauri-core') {
        const original = `/@fs/${path.join(root, 'node_modules/@tauri-apps/api/core.js')}`;
        return `export * from ${JSON.stringify(original)};
import { invoke as originalInvoke } from ${JSON.stringify(original)};
export function invoke(command, args, options) {
  const operation = () => originalInvoke(command, args, options);
  const observer = window.__DRIFTING_PERFORMANCE_AUDIT_INVOKE__;
  return observer ? observer(command, operation) : operation();
}`;
      }
      if (id !== '\0native-performance-audit-probe') return null;
      return `import { installNativePerformanceAudit } from '/scripts/native-performance-audit-probe.ts';\ninstallNativePerformanceAudit(${JSON.stringify({ endpoint, token })});\nexport { installNativePerformanceAudit };`;
    },
    configureServer(server) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(directory, 'control.json'), JSON.stringify({ endpoint: `${origin}${endpoint}`, token }), { mode: 0o600 });
      const git = args => execFileSync('git', args, { cwd: server.config.root, encoding: 'utf8' }).trim();
      const sourcePaths = ['src', 'src-tauri', 'crates', 'vendor', 'packages', 'vite-plugins', 'scripts', 'patches', 'drizzle',
        'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vite.renderer.config.ts', 'index.html', 'postcss.config.js', 'tailwind.config.js'];
      const files = [...new Set([
        ...git(['ls-files', '--cached', '--others', '--exclude-standard', '--', ...sourcePaths]).split('\n'),
        'scripts/native-performance-audit-plugin.mjs', 'scripts/native-performance-audit-probe.ts', 'scripts/native-performance-audit.mjs', 'scripts/native-performance-process-sampler.mjs',
      ])].filter(Boolean).sort();
      const hash = createHash('sha256');
      for (const file of files) hash.update(file).update('\0').update(readFileSync(path.join(server.config.root, file))).update('\0');
      writeFileSync(path.join(directory, 'source.json'), JSON.stringify({ head: git(['rev-parse', 'HEAD']),
        dirty: Boolean(git(['status', '--porcelain', '--untracked-files=all', '--', ...sourcePaths])),
        fingerprint: hash.digest('hex'), files: files.length, recordedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      const append = (file, data) => appendFileSync(path.join(directory, file), `${JSON.stringify({ ...data, receivedAt: Date.now() })}\n`, { mode: 0o600 });
      append('markers.jsonl', { marker });
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith(endpoint)) { next(); return; }
        if (req.headers.authorization !== `Bearer ${token}` || (req.headers.origin && req.headers.origin !== origin)) {
          res.writeHead(403).end(); return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'GET' && req.url === `${endpoint}/status`) {
          res.end(JSON.stringify({ marker, samples, latest })); return;
        }
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 256 * 1024) throw new Error('Oversized sample');
          }
          const data = JSON.parse(body);
          if (req.url === `${endpoint}/mark`) {
            if (typeof data.marker !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(data.marker)) throw new Error('Invalid marker');
            marker = data.marker;
            append('markers.jsonl', { marker });
          } else if (req.url === `${endpoint}/samples`) {
            latest = { ...data, marker };
            samples += 1;
            append('samples.jsonl', latest);
          } else { res.writeHead(404).end(); return; }
          res.end(JSON.stringify({ marker }));
        } catch { res.writeHead(400).end(); }
      });
    },
  };
}
