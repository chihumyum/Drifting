// Domain: ShadowJob — one persisted record per chapter shadow-review run, kept
// for observability. The right-rail Shadow panel lists these newest-first; a cell
// expands to its `trace` (the structured evidence-gathering + decision trail).
// Local-only telemetry — never synced.

export type ShadowJobStatus = 'running' | 'done' | 'failed' | 'stopped';

export type ShadowTracePhase = 'gather' | 'resolve' | 'check' | 'emit' | 'decide';

// One readable step in a review's trail. Phases come from the LangGraph nodes;
// `check` steps carry the agentic judge's per-rule evidence rounds + verdicts.
// `items` holds bullet lines (e.g. each evidence request, or each finding).
export interface ShadowTraceStep {
  at: string; // ISO timestamp
  phase: ShadowTracePhase;
  label: string; // headline, e.g. "读取章节快照" / "取证 · 第 2 轮" / "裁决：违反"
  detail?: string; // sub-line, e.g. the assertion text or a count summary
  items?: string[]; // optional bullet lines (evidence requests, findings, …)
}

export interface ShadowJob {
  id: string;
  projectId: string;
  chapterId: string;
  chapterTitle: string;
  status: ShadowJobStatus;
  decision: 'finished' | 'draft' | null;
  findingCount: number;
  error: string | null;
  trace: ShadowTraceStep[];
  archived: boolean;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
