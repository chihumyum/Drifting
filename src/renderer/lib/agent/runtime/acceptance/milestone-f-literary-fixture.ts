import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentContextEvidenceDocument } from '../context-evidence-retrieval';

const GOLDEN_PATH = join(
  process.cwd(),
  'src/renderer/lib/agent/runtime/acceptance/fixtures/synthetic-literary.golden.json',
);

interface GoldenElement {
  id: string;
  name: string;
  aliases?: string[];
  facts: Record<string, string>;
}

interface GoldenRule {
  id: string;
  checklist: Array<{ id: string; assertion: string }>;
}

interface GoldenChapter {
  id: string;
  title: string;
  summary: string;
}

interface GoldenFile {
  project: {
    projectId: string;
    facts: Record<string, string>;
    elements: GoldenElement[];
    rules: GoldenRule[];
    chapters: GoldenChapter[];
  };
}

export type MilestoneFLiteraryDimension =
  | 'canon_fact'
  | 'character_voice'
  | 'alias'
  | 'writing_rule'
  | 'chapter_evidence';

export interface MilestoneFLiteraryOracleCase {
  id: string;
  dimension: MilestoneFLiteraryDimension;
  query: string;
  expectedEvidenceId: string;
  expectedText: string;
}

export interface MilestoneFLiteraryFixture {
  projectId: string;
  documents: AgentContextEvidenceDocument[];
  oracle: MilestoneFLiteraryOracleCase[];
  syntheticCorpus: {
    generated: true;
    documents: number;
    bytes: number;
  };
}

function readGolden(): GoldenFile {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile;
}

function compactQuery(value: string): string {
  return [...value.replace(/[，。；：、（）【】“”"']/gu, ' ')].slice(0, 80).join('');
}

function syntheticChapterDocuments(chapters: GoldenChapter[]): {
  documents: AgentContextEvidenceDocument[];
  bytes: number;
} {
  const paragraphSeed = [
    '潮水擦过石阶，铜铃在雾里留下短促回声。旅人先数完桥柱间的距离，才允许自己抬头看那束摇晃的灯。',
    '她把海图压在木箱上，盐粒沿墨线滚动。每个可测量的细节都还在，只有北方像被谁从纸面剪走。',
    '远处的潮钟慢了一拍。值夜者没有解释，只把灯罩旋紧半圈，提醒她记住熄灯前最后一道影子的方向。',
    '旅人记录温度、风向和铃声间隔，不替任何人猜测动机。等证据排成一列，她才写下下一步航向。',
  ];
  const documents: AgentContextEvidenceDocument[] = [];
  let bytes = 0;

  for (let index = 0; index < 18; index += 1) {
    const chapter = chapters[index % chapters.length];
    const body = Array.from({ length: 95 }, (_, paragraphIndex) => {
      const seed = paragraphSeed[(index + paragraphIndex) % paragraphSeed.length];
      return `${seed} 这是合成章节 ${index + 1} 的段落 ${paragraphIndex + 1}，用于稳定测试长上下文切片、检索与压缩。`;
    }).join('\n');
    bytes += Buffer.byteLength(body, 'utf8');
    documents.push({
      evidenceId: `synthetic-chapter:${String(index + 1).padStart(2, '0')}`,
      kind: 'chapter',
      title: `${chapter.title}·合成切片${index + 1}`,
      ordinal: index,
      fields: body.split('\n').map((text, block) => ({
        kind: 'prose' as const,
        text,
        block: block + 1,
      })),
    });
  }
  return { documents, bytes };
}

export function loadMilestoneFLiteraryFixture(): MilestoneFLiteraryFixture {
  const golden = readGolden().project;
  const documents: AgentContextEvidenceDocument[] = [];
  const oracle: MilestoneFLiteraryOracleCase[] = [];

  for (const [key, value] of Object.entries(golden.facts)) {
    const evidenceId = `project:${golden.projectId}:${key}`;
    documents.push({
      evidenceId,
      kind: 'project',
      title: key,
      fields: [{ kind: 'fact', text: `${key}: ${value}` }],
    });
    oracle.push({
      id: `project-fact:${key}`,
      dimension: 'canon_fact',
      query: `${key} ${compactQuery(value)}`,
      expectedEvidenceId: evidenceId,
      expectedText: value,
    });
  }

  for (const element of golden.elements) {
    const evidenceId = `element:${element.id}`;
    documents.push({
      evidenceId,
      kind: 'element',
      title: element.name,
      fields: [
        { kind: 'title', text: element.name },
        ...(element.aliases ?? []).map((alias) => ({ kind: 'alias' as const, text: alias })),
        ...Object.entries(element.facts).map(([key, value]) => ({
          kind: 'fact' as const,
          text: `${key}: ${value}`,
        })),
      ],
    });
    for (const [key, value] of Object.entries(element.facts)) {
      oracle.push({
        id: `${element.id}:${key}`,
        dimension: key === '性格' ? 'character_voice' : 'canon_fact',
        query: `${element.name} ${key} ${compactQuery(value)}`,
        expectedEvidenceId: evidenceId,
        expectedText: value,
      });
    }
    for (const alias of element.aliases ?? []) {
      oracle.push({
        id: `${element.id}:alias:${alias}`,
        dimension: 'alias',
        query: alias,
        expectedEvidenceId: evidenceId,
        expectedText: element.name,
      });
    }
  }

  for (const rule of golden.rules) {
    for (const item of rule.checklist) {
      const evidenceId = `rule:${rule.id}:${item.id}`;
      documents.push({
        evidenceId,
        kind: 'writing_rule',
        title: rule.id,
        fields: [{ kind: 'fact', text: item.assertion }],
      });
      oracle.push({
        id: evidenceId,
        dimension: 'writing_rule',
        query: compactQuery(item.assertion),
        expectedEvidenceId: evidenceId,
        expectedText: item.assertion,
      });
    }
  }

  for (const [ordinal, chapter] of golden.chapters.entries()) {
    const evidenceId = `chapter:${chapter.id}`;
    documents.push({
      evidenceId,
      kind: 'chapter',
      title: chapter.title,
      ordinal,
      fields: [
        { kind: 'title', text: chapter.title },
        { kind: 'summary', text: chapter.summary },
      ],
    });
    oracle.push({
      id: `${chapter.id}:summary`,
      dimension: 'chapter_evidence',
      query: compactQuery(chapter.summary),
      expectedEvidenceId: evidenceId,
      expectedText: chapter.summary,
    });
  }

  const syntheticCorpus = syntheticChapterDocuments(golden.chapters);
  return {
    projectId: golden.projectId,
    documents: [...documents, ...syntheticCorpus.documents],
    oracle,
    syntheticCorpus: {
      generated: true,
      documents: syntheticCorpus.documents.length,
      bytes: syntheticCorpus.bytes,
    },
  };
}
