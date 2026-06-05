/**
 * Golden fixture (JSON on disk) → the in-memory EvalProject the execution core
 * consumes. A chapter carries either inline `blocks` or a `bodySource` pointing at a
 * vault markdown file — the latter is read at runtime (copyright-private manuscripts
 * stay out of git), parsed the same way the old golden.fog-harbor.ts did.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuleSpec } from '@/main/shadow/types';
import type { EvalProject } from '../model';
import { zGolden, type GoldenFile } from './schema';

const FOG_HARBOR_DIR = process.env.FOG_HARBOR_DIR || '/Users/example/我的ObsidianVault/雾港纪事/book-1';

// One markdown chapter → numbered blocks; a `#### 第N幕` header becomes a marker
// block so the judge sees act boundaries (per-act POV matters for head-hop).
function parseVaultMd(file: string, dir: string, chapterId: string): { id: string; text: string }[] {
  const md = readFileSync(join(dir, file), 'utf8');
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const h = line.match(/^#+\s*(.+)$/);
      return { id: `${chapterId}-p${i + 1}`, text: h ? `（${h[1]}）` : line };
    });
}

export function loadGoldenFile(path: string): GoldenFile {
  try {
    return zGolden.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new Error(`golden ${path} 加载失败：${(e as Error).message}`);
  }
}

export function goldenToProject(g: GoldenFile): EvalProject {
  return {
    projectId: g.project.projectId,
    facts: g.project.facts,
    elements: g.project.elements,
    rules: g.project.rules as RuleSpec[],
    chapters: g.project.chapters.map((c) => {
      let blocks = c.blocks;
      if (!blocks && c.bodySource) {
        const dir =
          c.bodySource.dir && c.bodySource.dir !== '$FOG_HARBOR_DIR' ? c.bodySource.dir : FOG_HARBOR_DIR;
        blocks = parseVaultMd(c.bodySource.file, dir, c.id);
      }
      return { id: c.id, title: c.title, summary: c.summary, appears: c.appears, blocks: blocks ?? [] };
    }),
  };
}
