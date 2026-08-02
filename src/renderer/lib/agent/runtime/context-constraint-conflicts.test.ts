import { describe, expect, it } from 'vitest';

import type { AgentContextConstraintLedgerEntry, AgentContextSourceRow } from './context-planner';
import {
  confirmedAgentContextConstraintConflictIds,
  detectAgentContextConstraintConflicts,
} from './context-constraint-conflicts';

function user(sourceId: string, ordinal: number, content: string): AgentContextSourceRow {
  return { sourceId, ordinal, turnOrdinal: ordinal, kind: 'user', content };
}

function entry(
  sourceId: string,
  kind: AgentContextConstraintLedgerEntry['kind'],
): AgentContextConstraintLedgerEntry {
  return { constraintId: `constraint:${sourceId}`, sourceId, sourceHash: 'hash', kind };
}

describe('context constraint conflicts', () => {
  it('detects contradictory fact values and instruction/veto pairs', () => {
    const rows = [
      user('fact-a', 0, '米拉的眼睛是绿色。'),
      user('fact-b', 1, '米拉的眼睛是蓝色。'),
      user('rule-a', 2, '必须保持第一人称视角。'),
      user('rule-b', 3, '不要保持第一人称视角。'),
    ];
    const conflicts = detectAgentContextConstraintConflicts({
      sourceRows: rows,
      ledger: [
        entry('fact-a', 'author_fact'),
        entry('fact-b', 'author_fact'),
        entry('rule-a', 'author_instruction'),
        entry('rule-b', 'author_veto'),
      ],
    });

    expect(conflicts.map((conflict) => conflict.kind).sort()).toEqual([
      'fact_value',
      'instruction_veto',
    ]);
  });

  it('treats an explicit later correction as resolved author intent', () => {
    expect(
      detectAgentContextConstraintConflicts({
        sourceRows: [
          user('old', 0, '米拉的眼睛是绿色。'),
          user('new', 1, '更正：米拉的眼睛是蓝色。'),
        ],
        ledger: [entry('old', 'author_fact'), entry('new', 'author_fact')],
      }),
    ).toEqual([]);
  });

  it('accepts only a successful durable ask_user answer as confirmation', () => {
    const conflictId = 'context-conflict:fact:a:b';
    const rows: AgentContextSourceRow[] = [
      {
        sourceId: 'call',
        ordinal: 0,
        turnOrdinal: 0,
        kind: 'tool_call',
        content: '{}',
        callId: 'ask-1',
        toolName: 'ask_user',
        toolAccess: 'read',
      },
      {
        sourceId: 'result',
        ordinal: 1,
        turnOrdinal: 0,
        kind: 'tool_result',
        content: JSON.stringify({
          callId: 'ask-1',
          name: 'ask_user',
          ok: true,
          content: JSON.stringify({
            result: {
              answer: '以蓝色为准。',
              confirmedConstraintConflictIds: [conflictId],
            },
          }),
        }),
        callId: 'ask-1',
        toolName: 'ask_user',
        toolAccess: 'read',
      },
    ];
    expect([...confirmedAgentContextConstraintConflictIds(rows)]).toEqual([conflictId]);
  });
});
