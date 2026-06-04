// Domain: ShadowJob — one persisted record per chapter shadow-review run, kept
// for observability. The right-rail Shadow panel lists these newest-first; a cell
// expands to its `trace` (the structured evidence-gathering + decision trail).
// Local-only telemetry — never synced.

export type ShadowJobStatus = 'running' | 'done' | 'failed' | 'stopped';

export type ShadowTracePhase = 'gather' | 'resolve' | 'check' | 'emit' | 'decide';

// Outcome of one tool call the FC judge made in a `查证` round. `denied` = the
// model called a non-existent/hallucinated tool (it was handed the real menu);
// `error` = the tool threw. Surfaced so the panel can show WHY a round was wasted.
export type ShadowToolStatus = 'ok' | 'denied' | 'error';
export interface ShadowToolCall {
  tool: string; // tool name as the model called it (incl. hallucinated ones)
  args?: string; // summarized args, e.g. "奥伦·维尔" or "11 1 60"
  status: ShadowToolStatus;
  note?: string; // e.g. "未知工具" / a short error message
  result?: string; // what the tool returned (as the model saw it), trace-capped
}

// One readable step in a review's trail. Phases come from the LangGraph nodes;
// `check` steps carry the agentic judge's per-rule evidence rounds + verdicts.
// `items` holds bullet lines (verdict reasons, evidence requests); `calls` holds
// the FC judge's structured per-round tool calls with their pass/deny/error status.
export interface ShadowTraceStep {
  at: string; // ISO timestamp
  phase: ShadowTracePhase;
  label: string; // headline, e.g. "读取章节快照" / "查证 · 第 2 轮" / "裁决：违反"
  detail?: string; // sub-line, e.g. the assertion text or a count summary
  items?: string[]; // optional bullet lines (evidence requests, findings, …)
  calls?: ShadowToolCall[]; // FC tool calls this round, with outcome status
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
