import { eq, inArray } from 'drizzle-orm';
import type { DbClient, DbExecutor } from '../../lib/db';
import {
  ProjectTable, SyncAppAuthorityTable, SyncGenerationTable, SyncProviderBindingTable,
  SyncProviderAccountTable, SyncConnectAttemptTable, SyncConnectGenerationAttemptTable,
  SyncRemoteObjectTable,
} from '../../schema/drizzle';
import { deleteProjectDataInTransaction } from '../../sqlite-repo/project-deletion-repo';

export class ProjectDeletionError extends Error {
  constructor(readonly code: 'connect' | 'account' | 'transition' | 'changed') {
    super(`Project deletion requires remote confirmation: ${code}`);
  }
}

export interface ProjectDeletionDependencies {
  readonly hostedEnabled: boolean;
  readonly accountSubject: () => string | null;
  readonly deleteRemote: (input: {
    accountSubject: string; syncGenerationId: string; signal: AbortSignal;
  }) => Promise<void>;
}

async function readPlan(db: DbExecutor, projectId: string, userId: string, hostedEnabled: boolean) {
  const [project] = await db.select({ userId: ProjectTable.userId }).from(ProjectTable)
    .where(eq(ProjectTable.id, projectId));
  if (!project) return null;
  if (project.userId !== userId) throw new ProjectDeletionError('account');
  const [authority] = await db.select().from(SyncAppAuthorityTable);
  if (authority && authority.transitionState !== 'stable') throw new ProjectDeletionError('transition');
  // Configured Hosted clients always require a remote operation, even for a pending genesis.
  if (hostedEnabled && authority?.mode !== 'hosted') throw new ProjectDeletionError('connect');
  const generations = await db.select().from(SyncGenerationTable)
    .where(eq(SyncGenerationTable.projectId, projectId));
  const ids = generations.map(row => row.syncGenerationId).sort();
  if (!ids.length) throw new ProjectDeletionError('changed');
  const accounts = await db.select().from(SyncProviderAccountTable);
  const targets = new Map<string, string>();
  const bindings = await db.select().from(SyncProviderBindingTable)
    .where(inArray(SyncProviderBindingTable.syncGenerationId, ids));
  const add = (id: string, account: string | null) => {
    if (!account || (targets.has(id) && targets.get(id) !== account)) throw new ProjectDeletionError('account');
    targets.set(id, account);
  };
  for (const binding of bindings) {
    const account = accounts.find(row => row.id === binding.providerAccountId);
    if (account?.providerKind !== 'hosted') throw new ProjectDeletionError('connect');
    add(binding.syncGenerationId, account.accountSubjectId);
  }
  // Disconnect removes bindings; durable connect receipts still own the remote generation.
  const attempts = await db.select({
    source: SyncConnectGenerationAttemptTable.sourceSyncGenerationId,
    target: SyncConnectGenerationAttemptTable.targetSyncGenerationId,
    account: SyncConnectAttemptTable.targetAccountSubjectId,
    mode: SyncConnectAttemptTable.targetMode,
  }).from(SyncConnectGenerationAttemptTable).innerJoin(SyncConnectAttemptTable,
    eq(SyncConnectAttemptTable.attemptId, SyncConnectGenerationAttemptTable.attemptId));
  const retainedDrive = new Set<string>();
  for (const attempt of attempts) {
    const id = attempt.target ?? attempt.source;
    if (!ids.includes(id)) continue;
    if (attempt.mode === 'hosted') add(id, attempt.account);
    if (attempt.mode === 'google-drive' && generations.some(row => row.syncGenerationId === id && row.status === 'retired'))
      retainedDrive.add(id);
  }
  if (authority?.mode === 'hosted') {
    const account = accounts.find(row => row.providerKind === 'hosted');
    for (const generation of generations) {
      if (generation.status === 'active') add(generation.syncGenerationId, account?.accountSubjectId ?? null);
    }
  }
  const remoteObjects = await db.select({ id: SyncRemoteObjectTable.syncGenerationId })
    .from(SyncRemoteObjectTable).where(inArray(SyncRemoteObjectTable.syncGenerationId, ids));
  // Never discard a disconnected replica whose remote ownership cannot be proved.
  if (remoteObjects.some(row => !targets.has(row.id) && !retainedDrive.has(row.id))) throw new ProjectDeletionError('connect');
  if (hostedEnabled && targets.size === 0) throw new ProjectDeletionError('connect');
  return { ids, targets: [...targets].sort(([a], [b]) => a.localeCompare(b)), authority };
}

/** No local deletion occurs until every owning Hosted generation acknowledges deletion. */
export async function deleteProjectWithRemoteConfirmation(input: {
  db: DbClient; projectId: string; userId: string; signal: AbortSignal;
  dependencies: ProjectDeletionDependencies;
}) {
  const { db, projectId, userId, dependencies, signal } = input;
  const plan = await readPlan(db, projectId, userId, dependencies.hostedEnabled);
  if (!plan) return null;
  const assertAccount = () => {
    signal.throwIfAborted();
    if (plan.targets.some(([, account]) => dependencies.accountSubject() !== account))
      throw new ProjectDeletionError('account');
  };
  for (const [syncGenerationId, accountSubject] of plan.targets) {
    assertAccount();
    await dependencies.deleteRemote({ syncGenerationId, accountSubject, signal });
    assertAccount();
  }
  return db.transaction(async tx => {
    assertAccount();
    const current = await readPlan(tx, projectId, userId, dependencies.hostedEnabled);
    if (!current || JSON.stringify(current) !== JSON.stringify(plan)) throw new ProjectDeletionError('changed');
    const receipt = await deleteProjectDataInTransaction(tx, projectId);
    const now = new Date().toISOString();
    await tx.update(SyncGenerationTable).set({ status: 'purged', purgedAt: now, updatedAt: now })
      .where(inArray(SyncGenerationTable.syncGenerationId, plan.ids));
    await tx.update(SyncProviderBindingTable).set({ state: 'purged', updatedAt: now })
      .where(inArray(SyncProviderBindingTable.syncGenerationId, plan.ids));
    return receipt;
  });
}

/** A verified Hosted 410 is terminal authority, including after a lost DELETE response. */
export async function applyHostedGenerationDeletion(db: DbClient, syncGenerationId: string) {
  return db.transaction(async tx => {
    const [generation] = await tx.select().from(SyncGenerationTable)
      .where(eq(SyncGenerationTable.syncGenerationId, syncGenerationId));
    if (!generation || generation.status !== 'active') return null;
    const projectId = generation.projectId;
    const receipt = projectId ? await deleteProjectDataInTransaction(tx, projectId) : null;
    const now = new Date().toISOString();
    await tx.update(SyncGenerationTable).set({ projectId: null, status: 'purged', purgedAt: now, updatedAt: now })
      .where(eq(SyncGenerationTable.syncGenerationId, syncGenerationId));
    await tx.update(SyncProviderBindingTable).set({ state: 'purged', updatedAt: now })
      .where(eq(SyncProviderBindingTable.syncGenerationId, syncGenerationId));
    return projectId && receipt ? { projectId, receipt } : null;
  });
}
