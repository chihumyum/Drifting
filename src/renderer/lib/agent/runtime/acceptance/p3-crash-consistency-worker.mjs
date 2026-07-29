import { DatabaseSync } from 'node:sqlite';
import process from 'node:process';

import {
  createP3CrashSchema,
  recoverP3CrashDatabase,
  writeThroughP3CrashMarker,
} from './p3-crash-consistency-contract.mjs';

function openDatabase(databasePath) {
  return new DatabaseSync(databasePath, {
    open: true,
    readOnly: false,
    enableForeignKeyConstraints: true,
  });
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const [mode, databasePath, marker, seedText] = process.argv.slice(2);
  const seed = Number(seedText);
  if (!Number.isSafeInteger(seed) || seed <= 0) {
    throw new Error(`Invalid P3 crash seed: ${seedText}`);
  }

  if (mode === 'write') {
    const db = openDatabase(databasePath);
    createP3CrashSchema(db, seed);
    writeThroughP3CrashMarker(db, marker, seed);
    emit({ ready: true, marker, seed, pid: process.pid });
    await new Promise(() => {});
    return;
  }

  if (mode === 'recover') {
    const db = openDatabase(databasePath);
    const result = recoverP3CrashDatabase(db, marker, seed);
    db.close();
    emit(result);
    return;
  }

  throw new Error(`Unknown P3 crash worker mode: ${String(mode)}`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
