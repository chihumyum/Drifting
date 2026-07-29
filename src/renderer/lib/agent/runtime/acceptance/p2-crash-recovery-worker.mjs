import { DatabaseSync } from 'node:sqlite';
import process from 'node:process';
import {
  createAcceptanceSchema,
  recoverAcceptanceDatabase,
  seedTenThousandEventDatabase,
  writeThroughCrashMarker,
} from './p2-crash-recovery-contract.mjs';

function parseArguments(argv) {
  const [mode, ...values] = argv;
  return { mode, values };
}

function openDatabase(path) {
  return new DatabaseSync(path, {
    open: true,
    readOnly: false,
    enableForeignKeyConstraints: true,
  });
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const { mode, values } = parseArguments(process.argv.slice(2));
  if (mode === 'write') {
    const [databasePath, marker, seedText, stopMode] = values;
    const seed = Number(seedText);
    const db = openDatabase(databasePath);
    createAcceptanceSchema(db);
    writeThroughCrashMarker(db, marker, seed);
    emit({ ready: true, marker, seed, pid: process.pid });
    if (stopMode === 'graceful') {
      db.close();
      return;
    }
    await new Promise(() => {});
    return;
  }

  if (mode === 'recover') {
    const [databasePath, marker] = values;
    const db = openDatabase(databasePath);
    const result = recoverAcceptanceDatabase(db, marker);
    db.close();
    emit(result);
    return;
  }

  if (mode === 'seed-10k') {
    const [databasePath] = values;
    const db = openDatabase(databasePath);
    seedTenThousandEventDatabase(db);
    db.close();
    emit({ seeded: true, eventCount: 10_000 });
    return;
  }

  throw new Error(`Unknown worker mode: ${String(mode)}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
