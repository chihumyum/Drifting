import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/renderer/schema/drizzle.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    // dev db path
    url: '/Users/example/Library/Application Support/Drifting/databases/JqhsLzV8eBuD7G2atU8nzrAkHQD3gtTP_drifting.db',
  },
});
