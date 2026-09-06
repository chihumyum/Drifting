import { Type } from '@sinclair/typebox';
import { ChatProtocolError } from './protocol';
import { Value } from '@sinclair/typebox/value';
import type { AgentChatMessage } from '../../domain/agent-conversation';
import type { AgentModelMessage } from '../../lib/agent/runtime/types';

const text = Type.String();
const at = Type.Optional(text);
const context = Type.Optional(
  Type.Array(
    Type.Object(
      {
        kind: Type.Union([Type.Literal('project'), Type.Literal('workspace')]),
        projectId: text,
        label: text,
        entityType: Type.Optional(
          Type.Union(
            ['node', 'element', 'storyline', 'category', 'all-chapters'].map((s) =>
              Type.Literal(s),
            ),
          ),
        ),
        entityId: Type.Optional(text),
        blockId: Type.Optional(text),
      },
      { additionalProperties: false },
    ),
  ),
);
const messageSchema = Type.Union([
  Type.Object({ kind: Type.Literal('user'), text, at, context }),
  ...['assistant', 'thinking', 'error'].map((kind) =>
    Type.Object({ kind: Type.Literal(kind), text, streaming: Type.Optional(Type.Boolean()) }),
  ),
  Type.Object({
    kind: Type.Literal('tool'),
    id: text,
    name: text,
    input: Type.Optional(Type.Unknown()),
    inputText: Type.Optional(text),
    status: Type.Union(['running', 'ok', 'error'].map((s) => Type.Literal(s))),
    result: Type.Optional(text),
  }),
  Type.Object({
    kind: Type.Literal('todos'),
    items: Type.Array(
      Type.Object({
        content: text,
        status: Type.Union(['pending', 'in_progress', 'completed'].map((s) => Type.Literal(s))),
        activeForm: Type.Optional(text),
      }),
    ),
  }),
  Type.Object({
    kind: Type.Literal('usage'),
    inputTokens: Type.Number(),
    outputTokens: Type.Number(),
    cacheReadTokens: Type.Number(),
    cacheCreationTokens: Type.Number(),
    costUsd: Type.Number(),
    turns: Type.Number(),
    at,
    durationMs: Type.Optional(Type.Number()),
    durationApiMs: Type.Optional(Type.Number()),
  }),
]);

/** Copy only presentation fields. Unknown future controls never enter the UI. */
export function portableDisplay(value: unknown): AgentChatMessage[] {
  if (!Array.isArray(value)) throw new ChatProtocolError('Invalid Agent history display');
  return value.map((row) => {
    if (!Value.Check(messageSchema, row))
      throw new ChatProtocolError('Invalid Agent history display row');
    const schema = messageSchema.anyOf.find((candidate) => Value.Check(candidate, row))!;
    return Object.fromEntries(
      Object.keys(schema.properties)
        .filter((key) => key in row)
        .map((key) => [key, (row as Record<string, unknown>)[key]]),
    ) as unknown as AgentChatMessage;
  });
}

/** Only structured result paging references are dependencies; arbitrary prose is data. */
export function historyResultRefs(messages: readonly AgentModelMessage[]): Set<string> {
  const refs = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const block of message.content) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.content);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      for (const value of [parsed, (parsed as { result?: unknown }).result]) {
        if (!value || typeof value !== 'object') continue;
        const candidate = value as { truncated?: unknown; resultRef?: unknown };
        if (
          typeof candidate.truncated === 'boolean' &&
          typeof candidate.resultRef === 'string' &&
          candidate.resultRef.startsWith('agent-result:')
        )
          refs.add(candidate.resultRef);
      }
    }
  }
  return refs;
}
