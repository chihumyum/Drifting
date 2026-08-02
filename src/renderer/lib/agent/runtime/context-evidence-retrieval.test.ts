import { describe, expect, it } from 'vitest';

import {
  rankAgentContextEvidence,
  tokenizeAgentContextEvidenceQuery,
  type AgentContextEvidenceDocument,
} from './context-evidence-retrieval';

const documents: AgentContextEvidenceDocument[] = [
  {
    evidenceId: 'element:lana',
    kind: 'element',
    title: '米拉',
    path: '/elements/人物/米拉/body.md',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 'element-r7',
    ordinal: 20,
    fields: [
      { kind: 'title', text: '米拉' },
      {
        kind: 'fact',
        text: '米拉必须通过手部接触攻击目标心智，可以控制行为但无法改变意识。',
      },
    ],
  },
  {
    evidenceId: 'chapter:recent',
    kind: 'chapter',
    title: '最近更新的一章',
    path: '/chapters/12/prose.md',
    updatedAt: '2026-08-01T00:00:00.000Z',
    revision: 'yjs-r99',
    ordinal: 12,
    fields: [{ kind: 'prose', text: '米拉走进房间，向众人点了点头。', block: 8 }],
  },
  {
    evidenceId: 'chapter:toll',
    kind: 'chapter',
    title: '荒原收费站',
    path: '/chapters/00/prose.md',
    updatedAt: '2025-12-01T00:00:00.000Z',
    revision: 'yjs-r3',
    ordinal: 0,
    fields: [
      {
        kind: 'prose',
        text: '收费站的栏杆在风里发出干涩的吱呀声。',
        block: 3,
      },
    ],
  },
];

describe('context evidence retrieval', () => {
  it('tokenizes mixed Chinese and Latin queries without losing exact names', () => {
    expect(tokenizeAgentContextEvidenceQuery('米拉 hand-contact 2次')).toEqual(
      expect.arrayContaining(['米拉', 'hand-contact', '2次']),
    );
  });

  it('ranks broad, authoritative fact coverage above a newer name-only distractor', () => {
    const matches = rankAgentContextEvidence({
      query: '米拉 手部接触 心智 控制行为',
      documents,
    });

    expect(matches[0]).toMatchObject({
      evidenceId: 'element:lana',
      matchedField: 'fact',
      freshness: { revision: 'element-r7' },
    });
    expect(matches[0]!.matchedTerms.length).toBeGreaterThan(
      matches[1]!.matchedTerms.length,
    );
  });

  it('returns Unicode-safe snippets, block provenance, path scoping, and stable freshness', () => {
    const matches = rankAgentContextEvidence({
      query: '收费站 栏杆',
      documents,
      pathPrefix: '/chapters',
      limit: 1,
    });

    expect(matches).toEqual([
      expect.objectContaining({
        evidenceId: 'chapter:toll',
        path: '/chapters/00/prose.md',
        block: 3,
        snippet: expect.stringContaining('收费站的栏杆'),
        freshness: {
          updatedAt: '2025-12-01T00:00:00.000Z',
          revision: 'yjs-r3',
        },
      }),
    ]);
  });
});
