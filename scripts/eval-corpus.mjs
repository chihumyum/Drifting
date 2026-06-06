#!/usr/bin/env node
/**
 * Interactive launcher for the data-driven shadow eval. `pnpm eval:corpus` (in a
 * TTY) lists the suites under corpus/suites/ and lets you pick one, then spawns
 * vitest with EVAL_SUITE set so only that suite runs.
 *
 *   pnpm eval:corpus              # interactive menu (pick suite, then repeat count)
 *   pnpm eval:corpus sample-screenplay       # run a named suite directly (no prompt)
 *   pnpm eval:corpus default      # the default battery (ci + fog-harbor-load + acceptance)
 *   pnpm eval:corpus list         # just print the suites
 *   EVAL_SUITE=sample-screenplay pnpm eval:corpus   # env wins, no prompt
 *   EVAL_REPEAT=3 pnpm eval:corpus       # preset repeat (env wins → skips repeat prompt)
 *
 * Non-TTY (CI / piped) falls back to the default battery — never hangs on input.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITES_DIR = join(ROOT, 'src/renderer/lib/shadow/eval/corpus/suites');
const EVAL_FILE = 'src/renderer/lib/shadow/eval/corpus.eval.ts';

function listSuites() {
  return readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith('.suite.json'))
    .map((f) => {
      const id = f.replace(/\.suite\.json$/, '');
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(SUITES_DIR, f), 'utf8'));
      } catch {
        /* ignore unreadable suite */
      }
      return { id, client: meta.client ?? '?', datasets: meta.datasets ?? [], repeat: meta.repeat };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function printMenu(suites) {
  console.log('\n可用 suite：');
  console.log('  0) 默认全套（ci + fog-harbor-load + acceptance）');
  suites.forEach((s, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}) ${s.id.padEnd(16)} [${String(s.client).padEnd(8)}] ${s.datasets.join(', ')}`,
    );
  });
}

function run(evalSuite, repeat) {
  const env = { ...process.env };
  if (evalSuite) env.EVAL_SUITE = evalSuite;
  else delete env.EVAL_SUITE;
  if (repeat) env.EVAL_REPEAT = String(repeat);
  const bin = join(ROOT, 'node_modules', '.bin', 'vitest');
  const child = spawn(bin, ['run', EVAL_FILE], { stdio: 'inherit', env, cwd: ROOT });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => {
    console.error(`无法启动 vitest：${e.message}`);
    process.exit(1);
  });
}

const suites = listSuites();
const arg = process.argv[2];

if (arg === 'list') {
  printMenu(suites);
  process.exit(0);
} else if (arg) {
  run(arg === 'all' || arg === 'default' ? '' : arg);
} else if (process.env.EVAL_SUITE) {
  run(process.env.EVAL_SUITE);
} else if (!process.stdin.isTTY) {
  run(''); // CI / piped → default battery, don't hang waiting for input
} else {
  printMenu(suites);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  (async () => {
    const t = (await ask('\n选择编号或名字（回车=默认全套）: ')).trim();
    if (!t || t === '0') {
      rl.close();
      return run('');
    }
    const pick = suites[Number(t) - 1] ?? suites.find((s) => s.id === t);
    if (!pick) {
      rl.close();
      console.error(`未知选择: ${t}`);
      process.exit(1);
    }
    // EVAL_REPEAT preset in env → skip the prompt and honor it.
    if (process.env.EVAL_REPEAT) {
      rl.close();
      return run(pick.id);
    }
    const def = pick.repeat ?? 1;
    const r = (await ask(`重复次数 repeat（回车=suite 默认 ${def}）: `)).trim();
    rl.close();
    const repeat = r ? Math.max(1, Number(r) || def) : undefined;
    run(pick.id, repeat);
  })();
}
