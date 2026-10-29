import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sentryVitePlugin } from '@sentry/vite-plugin';
// @ts-expect-error Build scripts are native ESM, outside the renderer type graph.
import { sentryBuildConfiguration } from './scripts/sentry-environment.mjs';
import { deferredAIProvidersPlugins } from './vite-plugins/deferred-ai-providers';
import { deferredSettingsPlugin, deferredProjectSettingsPlugins } from './vite-plugins/deferred-settings';
import { deferredSuperViewsPlugins } from './vite-plugins/deferred-super-views';

const EMBEDDED_SECRET_PATTERN = /^VITE_.*(?:API_KEY|SECRET|TOKEN)$/;

// https://vitejs.dev/config
export default defineConfig(({ command }) => {
  const isBuild = command === 'build';
  const outDir = process.env.DRIFTING_RENDERER_OUT_DIR || 'dist';
  const packagedAcceptance = process.env.DRIFTING_SENTRY_PACKAGED_ACCEPTANCE === '1';
  if (packagedAcceptance && (!isBuild || process.env.VITE_SENTRY_ENVIRONMENT !== 'sentry-acceptance'
    || process.env.VITE_LOCAL_ONLY_MODE !== 'false' || !process.env.VITE_SENTRY_DSN)) {
    throw new Error('Packaged Sentry acceptance requires an explicit Hosted-capable sentry-acceptance build and DSN');
  }
  const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  const sentry = sentryBuildConfiguration(process.env, { command, version,
    revision: process.env.DRIFTING_BUILD_REVISION || (process.env.VITE_LOCAL_ONLY_MODE === 'false' && process.env.VITE_SENTRY_DSN
      ? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() : 'unconfigured') });
  const tauriDevHost = process.env.TAURI_DEV_HOST;
  const configuredDevPort = Number(process.env.DRIFTING_VITE_PORT ?? '5173');
  const devPort = Number.isInteger(configuredDevPort) ? configuredDevPort : 5173;
  const disableAgentDebugHmr = process.env.VITE_DRIFTING_AGENT_DEBUG_DISABLE_HMR === '1';
  // A local release-performance measurement bundle (`dev:worktree --release-perf`):
  // production React with the frontend debug bridge, served from a private
  // profile and never packaged. Every other build compiles the bridge out.
  const perfBuild = isBuild && process.env.DRIFTING_PERF_BUILD === '1';

  if (isBuild) {
    if (!process.env.VITE_API_BASE_URL) {
      throw new Error(
        'VITE_API_BASE_URL must be provided explicitly for a renderer build; use pnpm tauri:build.',
      );
    }

    const embeddedSecrets = Object.entries(process.env)
      .filter(([key, value]) => EMBEDDED_SECRET_PATTERN.test(key) && Boolean(value))
      // The measurement bundle carries its loopback debug-session token, as a
      // development server does.
      .filter(([key]) => !(perfBuild && key === 'VITE_DRIFTING_FRONTEND_DEBUG_TOKEN'))
      .map(([key]) => key);
    if (embeddedSecrets.length > 0) {
      throw new Error(
        `Refusing to embed secret Vite variables in the renderer build: ${embeddedSecrets.join(', ')}`,
      );
    }
  }

  return {
    // Independent Hosted labs must not invalidate another running client's
    // optimized dependency URLs while compiling their mobile renderer.
    cacheDir: process.env.DRIFTING_VITE_CACHE_DIR || undefined,
    // Release builds accept only explicit process variables. This prevents ignored
    // developer .env files (including BYOK keys) from leaking into a bundle.
    envDir: isBuild ? false : undefined,
    plugins: [react(), ...(packagedAcceptance ? [{ name: 'sentry-packaged-acceptance',
      transformIndexHtml: { order: 'pre' as const, handler: () => [{ tag: 'script', attrs: { type: 'module', src: '/scripts/sentry-packaged-acceptance.ts' }, injectTo: 'body' as const }] },
    }] : []), deferredSettingsPlugin(), ...deferredProjectSettingsPlugins(), ...deferredSuperViewsPlugins(), ...deferredAIProvidersPlugins(),
      ...(isBuild && sentry ? [sentryVitePlugin({
        org: process.env.SENTRY_ORG, project: process.env.SENTRY_PROJECT, authToken: process.env.SENTRY_AUTH_TOKEN,
        release: { name: sentry.release }, telemetry: false,
        sourcemaps: { filesToDeleteAfterUpload: [path.join(outDir, '**/*.map')] },
      })] : [])],
    define: {
      'import.meta.env.VITE_DRIFTING_PERF_BUILD': JSON.stringify(perfBuild ? '1' : ''),
      ...(sentry ? {
        'import.meta.env.VITE_SENTRY_RELEASE': JSON.stringify(sentry.release),
        'import.meta.env.VITE_SENTRY_ENVIRONMENT': JSON.stringify(sentry.environment),
      } : {}),
    },
    // Only the app is a dev entry. Saved acceptance bundles and design HTML in
    // this checkout must not seed dependency scanning with retired imports.
    optimizeDeps: { entries: ['index.html'] },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // Transform the deferred workspace graph while the shelf starts. This
      // only warms Vite's cache; it does not execute code in the client.
      warmup: { clientFiles: ['./src/renderer/app/project-route-components.tsx'] },
      // Avoid clashing with a compatible local service on http://localhost:3000.
      port: devPort,
      strictPort: true,
      // Tauri sets this address for a physical mobile device. Listening only
      // on localhost installs the dev app successfully but leaves its WebView
      // unable to reach Vite over the local network.
      host: tauriDevHost || false,
      // A mounted-renderer long-task canary must not be invalidated by an
      // unrelated source save. This override is only consumed by Vite's local
      // dev server; ordinary development keeps HMR enabled.
      hmr: disableAgentDebugHmr
        ? false
        : tauriDevHost
          ? {
              protocol: 'ws',
              host: tauriDevHost,
              clientPort: devPort,
            }
          : true,
    },
    build: {
      outDir,
      sourcemap: sentry && isBuild ? 'hidden' : false,
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-router-dom'],
            tiptap: [
              '@tiptap/core',
              '@tiptap/react',
              '@tiptap/starter-kit',
              '@tiptap/extension-link',
              '@tiptap/extension-text-align',
              '@tiptap/extension-underline',
            ],
          },
        },
      },
    },
  };
});
