import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const reactPath = path.resolve(__dirname, 'node_modules/react');
const reactDomPath = path.resolve(__dirname, 'node_modules/react-dom');

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      react: reactPath,
      'react-dom': reactDomPath,
    },
  },
  server: {
    // Avoid clashing with private service (http://localhost:3000)
    port: 5173,
    strictPort: true,
    hmr: true,
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
});
