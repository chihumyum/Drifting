import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/renderer/schema/drizzle.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    // Schema generation normally does not open a database. Set DRIFTING_DB_PATH
    // explicitly for an intentional drizzle-kit inspection/push operation.
    url: process.env.DRIFTING_DB_PATH ?? '.local-data/databases/drifting-library.db',
  },
});
