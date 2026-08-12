/** Pure names/access contract shared by production composition and tooling. */
export const AGENT_LONG_TASK_READ_TOOL = 'read_task_plan' as const;
export const AGENT_PROJECT_HANDOFF_READ_TOOL = 'read_project_handoff' as const;
export const AGENT_LONG_TASK_PLAN_TOOL = 'update_task_plan' as const;
export const AGENT_LONG_TASK_STEP_TOOL = 'update_task_step' as const;
export const AGENT_LONG_TASK_CONSTRAINT_TOOL = 'update_task_constraint' as const;

export const AGENT_LONG_TASK_TOOL_CONTRACTS = [
  { name: AGENT_LONG_TASK_READ_TOOL, access: 'read' },
  { name: AGENT_PROJECT_HANDOFF_READ_TOOL, access: 'read' },
  { name: AGENT_LONG_TASK_PLAN_TOOL, access: 'write' },
  { name: AGENT_LONG_TASK_STEP_TOOL, access: 'write' },
  { name: AGENT_LONG_TASK_CONSTRAINT_TOOL, access: 'write' },
] as const;

/** Machine-readable product promises closed by Milestone E. */
export const AGENT_LONG_TASK_EXECUTION_CONTRACT = {
  defaultTaskBudgets: 'unlimited',
  continuationAuthorization: 'renderer-lifetime-author-action',
  stopBoundary: 'after-current-tool',
  steeringBoundary: 'next-model-iteration-exactly-once',
  restartBehavior: 'durable-plan-manual-reauthorization',
  manifestPolicy: 'detect-explicitly-reconcile-before-completion',
  completionPolicy: 'current-manifest-plus-work-kind-evidence',
  automaticContinuationPrompts: 'model-visible-transcript-hidden',
  stagnantSliceWatchdog: 2,
} as const;

const LONG_TASK_TOOL_ACCESS = new Map<string, 'read' | 'write'>(
  AGENT_LONG_TASK_TOOL_CONTRACTS.map((tool) => [tool.name, tool.access]),
);

export function resolveAgentLongTaskToolAccess(name: string): 'read' | 'write' | undefined {
  return LONG_TASK_TOOL_ACCESS.get(name);
}
