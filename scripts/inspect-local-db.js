#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function resolvePath(input) {
  if (path.isAbsolute(input)) return input;
  return path.resolve(process.cwd(), input);
}

function tauriDataDbDir() {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'cc.drifting.client',
      'databases',
    );
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'cc.drifting.client',
      'databases',
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'cc.drifting.client',
    'databases',
  );
}

function runSqlite(dbPath, sql) {
  return spawnSync('sqlite3', ['-header', '-column', dbPath, sql], {
    encoding: 'utf8',
  });
}

function printCommandFailure(result) {
  if (result.error) {
    console.error(result.error.message);
    return;
  }
  if (result.stderr) {
    console.error(result.stderr.trim());
  }
}

function fileStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size} bytes, mtime=${stat.mtime.toISOString()}, ino=${stat.ino}`;
  } catch {
    return 'missing';
  }
}

function inspectDb(dbPath) {
  console.log(`\nDB ${dbPath}`);
  console.log(`  main ${fileStat(dbPath)}`);
  console.log(`  wal  ${fileStat(`${dbPath}-wal`)}`);
  console.log(`  shm  ${fileStat(`${dbPath}-shm`)}`);

  const tablesResult = runSqlite(
    dbPath,
    "select name from sqlite_master where type='table' order by name;",
  );
  if (tablesResult.status !== 0) {
    printCommandFailure(tablesResult);
    return;
  }

  const tables = tablesResult.stdout
    .split(/\r?\n/)
    .slice(2)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!tables.includes('project')) {
    console.log('  project table: missing');
    return;
  }

  const counts = [
    ['project', 'project'],
    ['storylines', 'storylines'],
    ['element_category', 'element_category'],
    ['book_node', 'book_node'],
    ['element', 'element'],
    ['library_item', 'library_item'],
    ['project_asset', 'project_asset'],
    ['entity_relation', 'entity_relation'],
  ]
    .filter(([, table]) => tables.includes(table))
    .map(([label, table]) => `select '${label}' as table_name, count(*) as count from ${table}`)
    .join(' union all ');

  if (counts) {
    const countsResult = runSqlite(dbPath, `${counts};`);
    if (countsResult.status === 0) {
      console.log(countsResult.stdout.trim());
    } else {
      printCommandFailure(countsResult);
    }
  }

  const projectsResult = runSqlite(
    dbPath,
    'select id,user_id,name,created_at,updated_at from project order by created_at desc limit 20;',
  );
  if (projectsResult.status === 0) {
    console.log(projectsResult.stdout.trim() || 'projects: none');
  } else {
    printCommandFailure(projectsResult);
  }
}

function addDir(dirs, label, dir) {
  if (!dir) return;
  const resolved = resolvePath(dir);
  if (!dirs.some((item) => item.dir === resolved)) {
    dirs.push({ label, dir: resolved });
  }
}

function main() {
  const sqliteVersion = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
  if (sqliteVersion.status !== 0) {
    console.error('sqlite3 is required on PATH.');
    process.exit(1);
  }

  const dirs = [];
  addDir(dirs, 'DRIFTING_DB_DIR/local', process.env.DRIFTING_DB_DIR || '.local-data/databases');

  if (
    process.env.DRIFTING_DB_INSPECT_USERDATA === '1' ||
    process.argv.includes('--all') ||
    process.argv.includes('--user-data')
  ) {
    addDir(dirs, 'Tauri app data', tauriDataDbDir());
  }

  for (const { label, dir } of dirs) {
    console.log(`\n== ${label}: ${dir} ==`);
    if (!fs.existsSync(dir)) {
      console.log('missing');
      continue;
    }

    const dbFiles = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .sort()
      .map((name) => path.join(dir, name));

    if (dbFiles.length === 0) {
      console.log('no .db files');
      continue;
    }

    for (const dbPath of dbFiles) {
      inspectDb(dbPath);
    }
  }
}

main();
