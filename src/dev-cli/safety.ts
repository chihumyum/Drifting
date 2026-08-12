import { access, lstat, mkdir, realpath, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { CliError } from './protocol';

export interface ResolvedDatabaseTarget {
  path: string;
  isUserData: boolean;
}

function defaultUserDataDirectories(): string[] {
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library/Application Support/cc.drifting.client/databases')];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    return local ? [join(local, 'cc.drifting.client/databases')] : [];
  }
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
  return [join(data, 'cc.drifting.client/databases')];
}

async function existingDatabaseFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.db'))
      .map((entry) => join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function resolveDatabaseTarget(
  explicitPath: string | undefined,
  offlineUserdata: boolean,
): Promise<ResolvedDatabaseTarget> {
  let candidate: string | undefined;
  if (explicitPath) {
    candidate = isAbsolute(explicitPath) ? explicitPath : resolve(explicitPath);
  } else if (offlineUserdata) {
    const files = (
      await Promise.all(defaultUserDataDirectories().map(existingDatabaseFiles))
    ).flat();
    if (files.length !== 1) {
      throw new CliError(
        'DATABASE_SELECTION_REQUIRED',
        `Expected exactly one Drifting user-data database, found ${files.length}; pass --db explicitly`,
        { candidates: files },
      );
    }
    candidate = files[0];
  }
  if (!candidate) {
    throw new CliError(
      'DATABASE_REQUIRED',
      'Workspace commands require --db or --offline-userdata',
    );
  }
  await access(candidate, constants.R_OK);
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink())
    throw new CliError('DATABASE_SYMLINK_REFUSED', 'Database path must not be a symbolic link');
  if (!stat.isFile()) throw new CliError('DATABASE_INVALID', 'Database path is not a regular file');
  const canonical = await realpath(candidate);
  const userDataRoots = await Promise.all(
    defaultUserDataDirectories().map(async (path) => {
      try {
        return await realpath(path);
      } catch {
        return resolve(path);
      }
    }),
  );
  return {
    path: canonical,
    isUserData: userDataRoots.some(
      (root) => canonical.startsWith(`${root}/`) || canonical === root,
    ),
  };
}

async function commandOutput(
  command: string,
  args: readonly string[],
): Promise<{ code: number; output: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolveResult({ code: code ?? 1, output: Buffer.concat(chunks).toString('utf8').trim() }),
    );
  });
}

export async function assertDatabaseExclusive(databasePath: string): Promise<void> {
  try {
    const result = await commandOutput('lsof', [
      '-F',
      'pcn',
      '--',
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]);
    if (result.code === 0 && result.output) {
      throw new CliError('DATABASE_IN_USE', 'Drifting must be closed before an offline write', {
        lsof: result.output,
      });
    }
    if (result.code !== 0 && result.code !== 1) {
      throw new CliError(
        'EXCLUSIVITY_CHECK_FAILED',
        `lsof failed with exit code ${result.code}`,
        result.output,
      );
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const { DatabaseSync } = await import('node:sqlite');
      const probe = new DatabaseSync(databasePath, { readOnly: false });
      try {
        probe.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK;');
      } catch (cause) {
        throw new CliError(
          'DATABASE_IN_USE',
          'Could not acquire an exclusive SQLite lock',
          cause instanceof Error ? cause.message : String(cause),
        );
      } finally {
        probe.close();
      }
      return;
    }
    throw error;
  }
}

export function assertOfflineWriteAuthorized(input: {
  target: ResolvedDatabaseTarget;
  offlineUserdata: boolean;
  yes: boolean;
}): void {
  if (!input.offlineUserdata || !input.yes) {
    throw new CliError(
      'OFFLINE_WRITE_CONFIRMATION_REQUIRED',
      'Real workspace writes require both --offline-userdata and --yes',
    );
  }
  if (!input.target.isUserData && !process.env.DRIFTING_CLI_ALLOW_NON_USERDATA_WRITE) {
    throw new CliError(
      'NON_USERDATA_WRITE_REFUSED',
      'The resolved database is outside Drifting user data; set DRIFTING_CLI_ALLOW_NON_USERDATA_WRITE=1 only for an isolated fixture',
    );
  }
}

export async function backupDatabase(databasePath: string, requestId: string): Promise<string> {
  const { backup, DatabaseSync } = await import('node:sqlite');
  const backupDirectory = join(dirname(databasePath), 'cli-backups');
  await mkdir(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const destination = join(
    backupDirectory,
    `${basename(databasePath, '.db')}-${timestamp}-${requestId}.db`,
  );
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backup(source, destination);
  } finally {
    source.close();
  }
  return destination;
}

export async function prepareOfflineMutation(input: {
  target: ResolvedDatabaseTarget;
  offlineUserdata: boolean;
  yes: boolean;
  requestId: string;
}): Promise<string> {
  assertOfflineWriteAuthorized(input);
  await assertDatabaseExclusive(input.target.path);
  return backupDatabase(input.target.path, input.requestId);
}
