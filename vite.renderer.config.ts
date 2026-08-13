import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const EMBEDDED_SECRET_PATTERN = /^VITE_.*(?:API_KEY|SECRET|TOKEN)$/;

// https://vitejs.dev/config
export default defineConfig(({ command }) => {
  const isBuild = command === 'build';
  const tauriDevHost = process.env.TAURI_DEV_HOST;
  const configuredDevPort = Number(process.env.DRIFTING_VITE_PORT ?? '5173');
  const devPort = Number.isInteger(configuredDevPort) ? configuredDevPort : 5173;
  const disableAgentDebugHmr = process.env.VITE_DRIFTING_AGENT_DEBUG_DISABLE_HMR === '1';

  if (isBuild) {
    if (!process.env.VITE_API_BASE_URL) {
      throw new Error(
        'VITE_API_BASE_URL must be provided explicitly for a renderer build; use pnpm tauri:build.',
      );
    }

    const embeddedSecrets = Object.entries(process.env)
      .filter(([key, value]) => EMBEDDED_SECRET_PATTERN.test(key) && Boolean(value))
      .map(([key]) => key);
    if (embeddedSecrets.length > 0) {
      throw new Error(
        `Refusing to embed secret Vite variables in the renderer build: ${embeddedSecrets.join(', ')}`,
      );
    }
  }

  return {
    // Release builds accept only explicit process variables. This prevents ignored
    // developer .env files (including BYOK keys) from leaking into a bundle.
    envDir: isBuild ? false : undefined,
    plugins: [react()],
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
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
