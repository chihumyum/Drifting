export const AGENT_PROJECT_HANDOFF_SCHEMA_VERSION = 1 as const;

export interface AgentProjectHandoffStepSummary {
  ordinal: number;
  title: string;
  workKind: 'edit' | 'review' | 'research';
  target: { kind: string; name: string } | null;
  status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'retired';
}

export interface AgentProjectHandoffTaskSummary {
  sourceConversationTitle: string;
  sourceSessionRunning: boolean;
  objective: string;
  scopeKind: 'explicit_targets' | 'whole_book_chapters';
  workKind: 'edit' | 'review';
  status: 'active' | 'paused' | 'blocked';
  updatedAt: string;
  progress: {
    total: number;
    completed: number;
    remaining: number;
    blocked: number;
    failed: number;
    retired: number;
  };
  activeConstraints: string[];
  completedSteps: AgentProjectHandoffStepSummary[];
  remainingSteps: AgentProjectHandoffStepSummary[];
  stepsTruncated: boolean;
}

export interface AgentProjectHandoffNameList {
  names: string[];
  truncated: boolean;
}

export interface AgentProjectHandoffNameIndex {
  chapters: AgentProjectHandoffNameList;
  inspirations: AgentProjectHandoffNameList;
  elements: AgentProjectHandoffNameList;
  categories: AgentProjectHandoffNameList;
  storylines: AgentProjectHandoffNameList;
}

export interface AgentProjectHandoffWriteSummary {
  sourceConversationTitle: string;
  target: string;
  outcome: 'committed' | 'pending_review' | 'accepted' | 'attention_required';
  updatedAt: string;
}

/**
 * Rebuildable, project-local orientation for a fresh General Agent session.
 * It deliberately excludes transcript text, prose, internal ids, permissions,
 * provider state, and any authority to control the source sessions.
 */
export interface AgentProjectHandoff {
  schemaVersion: typeof AGENT_PROJECT_HANDOFF_SCHEMA_VERSION;
  snapshotAt: string;
  projectName: string | null;
  tasks: AgentProjectHandoffTaskSummary[];
  taskLimitReached: boolean;
  currentNames: AgentProjectHandoffNameIndex;
  recentWrites: AgentProjectHandoffWriteSummary[];
  writeLimitReached: boolean;
}
