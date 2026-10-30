import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The share-link reader (docs/share-links.md): a static page the Hosted
// operator serves at /s/<token> beside the API. Development proxies /api to
// the service so the account cookie stays first-party.
export default defineConfig({
  root: 'src/share-web',
  base: '/s/',
  plugins: [react()],
  build: {
    outDir: '../../dist-share-web/s',
    emptyOutDir: true,
  },
  server: {
    host: 'localhost',
    port: 5180,
    strictPort: true,
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: process.env.DRIFTING_HOSTED_ORIGIN || 'http://localhost:3000' },
    },
  },
});
