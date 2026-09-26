import { readNewAuthoredMaterializationOriginal } from './repository';
import type { DbExecutor, DbTransaction } from '../../lib/db';
import { insertYjsMaterializationReceiptsInTransaction } from '../../sqlite-repo/yjs-materialization-receipt-repo';
import {
  readMaterializationAppend,
  type YjsMaterializationToken,
} from '../../sqlite-repo/yjs-repo';
import type { SyncChangeBuilder } from './change-builder';
const appended = new WeakMap<
  SyncChangeBuilder,
  Array<{
    readonly tx: DbExecutor;
    readonly mutationIndex: number;
    readonly token: YjsMaterializationToken;
  }>
>();
/** The index is fixed before append; final incarnation is resolved by finalization. */
export function registerAuthoredYjsMaterialization(
  tx: DbExecutor,
  builder: SyncChangeBuilder,
  mutationIndex: number,
  token: YjsMaterializationToken,
): void {
  if (builder.isFinalized) throw new Error('Cannot register materialization after finalization');
  readMaterializationAppend(tx, token, { kind: 'authored', builder, mutationIndex });
  const records = appended.get(builder) ?? [];
  if (records.some((value) => value.mutationIndex === mutationIndex || value.token === token))
    throw new Error('Duplicate authored materialization registration');
  records.push({ tx, mutationIndex, token });
  appended.set(builder, records);
}
export async function persistAuthoredYjsMaterializations(
  tx: DbTransaction,
  builder: SyncChangeBuilder,
  createdAt: string,
): Promise<void> {
  const { changeSetId } = readNewAuthoredMaterializationOriginal(tx, builder);
  const inputs = (appended.get(builder) ?? []).map((record) => {
    if (record.tx !== tx) {
      throw new Error('Authored materialization escaped its original transaction');
    }
    return {
      changeSetId,
      mutationIndex: record.mutationIndex,
      token: record.token,
      binding: { kind: 'authored' as const, builder, mutationIndex: record.mutationIndex },
      createdAt,
    };
  });
  await insertYjsMaterializationReceiptsInTransaction(tx, inputs);
}
