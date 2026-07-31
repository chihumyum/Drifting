import { describe, expect, it } from 'vitest';
import { matchesDriftingAgentWriteReviewProvenance } from './write-review-provenance';

const expected = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  callId: 'write-1',
  toolName: 'edit_block',
};
const toolCallId = 'agent-tool:session-1:turn-1:write-1';
const review = {
  id: 'review-1',
  effectId: 'effect-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId,
};
const effect = {
  id: 'effect-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId,
  callId: 'write-1',
  toolName: 'edit_block',
  phase: 'result_committed',
};

describe('Agent write-review provenance', () => {
  it('accepts only the exact durable session/turn/call/tool binding', () => {
    expect(matchesDriftingAgentWriteReviewProvenance(review, effect, expected)).toBe(true);
  });

  it('rejects a review id echoed by another dynamic or MCP tool call', () => {
    expect(
      matchesDriftingAgentWriteReviewProvenance(review, effect, {
        ...expected,
        callId: 'mcp-call-1',
        toolName: 'mcp__external__echo',
      }),
    ).toBe(false);
  });
});
