import { and, eq, inArray } from 'drizzle-orm';
import { getDb, type DbClient } from '../../lib/db';
import {
  SyncAppAuthorityTable,
  SyncProviderAccountTable,
  SyncProviderBindingTable,
} from '../../schema/drizzle';

/** A newly verified session can unblock authentication errors, never corruption/version errors. */
export async function resumeHostedAuthentication(
  accountSubject: string,
  db: DbClient = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [authority] = await tx.select().from(SyncAppAuthorityTable).limit(1);
    if (authority?.mode !== 'hosted' || authority.transitionState !== 'stable') return;
    const accounts = await tx
      .select()
      .from(SyncProviderAccountTable)
      .where(
        and(
          eq(SyncProviderAccountTable.providerKind, 'hosted'),
          eq(SyncProviderAccountTable.authorityGeneration, authority.generation),
          eq(SyncProviderAccountTable.accountSubjectId, accountSubject),
        ),
      );
    if (accounts.length === 0) return;
    await tx
      .update(SyncProviderBindingTable)
      .set({ state: 'ready', updatedAt: new Date().toISOString() })
      .where(
        and(
          inArray(
            SyncProviderBindingTable.providerAccountId,
            accounts.map((a) => a.id),
          ),
          eq(SyncProviderBindingTable.state, 'needs-reauth'),
        ),
      );
  });
}
