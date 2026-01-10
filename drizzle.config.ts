import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/renderer/schema/drizzle.ts',
  out: './drizzle',
  dialect: 'sqlite',
});
