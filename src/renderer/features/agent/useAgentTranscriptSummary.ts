import { useMemo, useState } from 'react';
import { createAgentTranscriptSummary } from './agent-transcript-summary';
import type { AgentMessageBlock } from './useAgentMessageBlocks';

export function useAgentTranscriptSummary(blocks: readonly AgentMessageBlock[]) {
  const [project] = useState(createAgentTranscriptSummary);
  return useMemo(() => project(blocks), [blocks, project]);
}
