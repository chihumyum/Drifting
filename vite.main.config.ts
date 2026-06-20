import { defineConfig, loadEnv } from 'vite';
import path from 'node:path';

// https://vitejs.dev/config
export default defineConfig(({ mode }) => {
  // Load ALL env vars (incl. non-VITE_ ones like API_BASE_URL) from .env[.mode].
  const env = loadEnv(mode, process.cwd(), '');

  return {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
      // Some libs that can run in both Web and Node.js environments
      // will export Node.js module by default, but Vite may build error
      // So we need to specify them as external
      browserField: false,
      conditions: ['node'],
      mainFields: ['module', 'jsnext:main', 'jsnext'],
    },
    build: {
      rollupOptions: {
        external: [
          // Native modules must be external — rollup can't bundle .node binaries.
          'better-sqlite3',
          '@napi-rs/keyring',
          // Match every platform-suffixed prebuild (-darwin-arm64 / -linux-x64 / ...).
          /^@napi-rs\/keyring-/,
          // Claude Agent SDK (ESM, spawns a native binary) — resolve at runtime
          // from node_modules; never bundle it or its per-platform binary package.
          '@anthropic-ai/claude-agent-sdk',
          /^@anthropic-ai\/claude-agent-sdk/,
          // LangGraph (shadow workflow) — ESM, resolve at runtime from node_modules
          // like the Agent SDK. Never bundle it (avoids CJS/ESM interop trouble).
          '@langchain/langgraph',
          '@langchain/core',
          /^@langchain\//,
          // Also exclude electron and node built-ins
          'electron',
          'fs',
          'path',
          'crypto',
        ],
      },
    },
    // A packaged build can't read a .env at runtime (main.ts loadLocalEnv finds
    // nothing inside the asar), so process.env.API_BASE_URL would fall back to
    // localhost. Bake it for PRODUCTION only; dev keeps reading .env at runtime
    // so local overrides still work.
    ...(mode === 'production'
      ? {
          define: {
            'process.env.API_BASE_URL': JSON.stringify(
              env.API_BASE_URL || 'https://api.drifting.cc',
            ),
          },
        }
      : {}),
  };
});
