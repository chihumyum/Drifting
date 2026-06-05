/**
 * Load datasets (JSONL, one case per line — git diff = line-level) and suites
 * (JSON). Each line is validated against the case schema with its file+line in the
 * error, so a malformed row points you straight at it.
 */
import { readFileSync } from 'node:fs';
import { zCase, zSuite, type EvalCase, type Suite } from './schema';

export function loadDataset(path: string): EvalCase[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (e) {
        throw new Error(`${path}:${i + 1} JSON 解析失败：${(e as Error).message}`);
      }
      try {
        return zCase.parse(json);
      } catch (e) {
        throw new Error(`${path}:${i + 1} case 校验失败：${(e as Error).message}`);
      }
    });
}

export function loadSuite(path: string): Suite {
  try {
    return zSuite.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new Error(`suite ${path} 加载失败：${(e as Error).message}`);
  }
}
