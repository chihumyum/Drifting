/**
 * Device-local library state (`library_state`, migration 0014): one JSON value
 * per key, outside every project. Never synced or journaled.
 */
import { eq } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { LibraryStateTable } from '../schema/drizzle';

export interface LibraryStateRepository {
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T, updatedAt: string): Promise<void>;
}

export function createLibraryStateRepository(dbOverride?: DbExecutor): LibraryStateRepository {
  const db = () => dbOverride ?? getDb();
  return {
    async read<T>(key: string): Promise<T | null> {
      const [row] = await db()
        .select({ valueJson: LibraryStateTable.valueJson })
        .from(LibraryStateTable)
        .where(eq(LibraryStateTable.key, key))
        .limit(1);
      return row ? (JSON.parse(row.valueJson) as T) : null;
    },
    async write<T>(key: string, value: T, updatedAt: string): Promise<void> {
      const valueJson = JSON.stringify(value);
      await db()
        .insert(LibraryStateTable)
        .values({ key, valueJson, updatedAt })
        .onConflictDoUpdate({ target: LibraryStateTable.key, set: { valueJson, updatedAt } });
    },
  };
}
