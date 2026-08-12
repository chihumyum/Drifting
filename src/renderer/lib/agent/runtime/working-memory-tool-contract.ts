export const AGENT_WORKING_MEMORY_READ_TOOL = 'read_working_memory' as const;

export const AGENT_WORKING_MEMORY_CHECKPOINT_TOOL = 'checkpoint_working_memory' as const;

export const AGENT_WORKING_MEMORY_TOOL_NAMES = [
  AGENT_WORKING_MEMORY_READ_TOOL,
  AGENT_WORKING_MEMORY_CHECKPOINT_TOOL,
] as const;
