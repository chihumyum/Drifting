import type { DbExecutor } from '../../../lib/db';
import type { AgentAuthoredJournal } from './agent-authored-journal';
import type { SyncChangeBuilder } from '../../../sync/journal';

/**
 * Workbench commands: Agent writes to the author's working structure around
 * the prose — material folders and metadata, acts, reading order, the
 * narrative timeline and chapter plot grids.
 *
 * Each command plans a complete next image of one small *scope* (the whole
 * material library, the whole book structure, one chapter's plot grid). The
 * scope image is the freshness revision, the receipt pre/postimage and the
 * exact inverse at once: rejecting a write applies the same diff backwards
 * after proving nothing changed since. This mirrors storyline membership,
 * which snapshots its whole graph for the same reason.
 */
export interface WorkbenchApplyInput<S> {
  projectId: string;
  /** The scope instance: the project id, or the chapter a plot grid belongs to. */
  scopeId: string;
  from: S;
  to: S;
  direction: 'forward' | 'inverse';
  /** Command-owned data that does not belong in the scope image. */
  extra: unknown;
  changes: SyncChangeBuilder;
  journal: AgentAuthoredJournal;
  at: string;
}

export interface WorkbenchScope<S> {
  /** Observation and receipt scope name, e.g. `material_library`. */
  kind: string;
  /** Canonical read tool whose receipt observes this scope. */
  readTool: string;
  /** Arguments for `readTool` that observe the scope `scopeId`. */
  readArguments(scopeId: string, projectId: string): Record<string, unknown>;
  /** Exact current image, loaded through `db` (a transaction when mutating). */
  load(db: DbExecutor, projectId: string, scopeId: string): Promise<S>;
  /** Persist `from → to` and journal every authored mutation. */
  apply(tx: DbExecutor, input: WorkbenchApplyInput<S>): Promise<void>;
  /** Refresh renderer stores after a committed forward or inverse. */
  project(projectId: string, scopeId: string): Promise<void>;
}

export interface WorkbenchResolution {
  /** Hidden command arguments: author-domain names resolved to ids. */
  arguments: Record<string, unknown>;
  /** Model-visible identity of the written object. */
  path: string;
  /** One author-language sentence describing the change. */
  changeSummary: string;
}

export interface WorkbenchPlanContext {
  projectId: string;
  idempotencyKey: string;
  at: string;
}

export interface WorkbenchPlan<S> {
  next: S;
  extra?: unknown;
}

export interface WorkbenchCommand<S> {
  name: string;
  scope: WorkbenchScope<S>;
  /** The scope instance a call writes; resolves names through the store. */
  scopeId(projectId: string, args: Readonly<Record<string, unknown>>): string;
  /** Validate author-domain arguments against the current image. */
  resolve(state: S, args: Readonly<Record<string, unknown>>, projectId: string): WorkbenchResolution;
  /** The next image for resolved arguments. Throws when nothing would change. */
  plan(state: S, args: Readonly<Record<string, unknown>>, context: WorkbenchPlanContext): Promise<WorkbenchPlan<S>>;
  /** Refuse an inverse that would discard later author work outside the image. */
  assertInverseSafe?(tx: DbExecutor, projectId: string, extra: unknown): Promise<void>;
  /**
   * The image a reject restores, when it cannot be the preimage itself. Sync
   * never revives a purged id, so undoing a hard delete recreates the row
   * under a new id planned in `extra`; everything else is restored exactly.
   */
  inverseImage?(before: S, extra: unknown): S;
}

/** The requested state is already current: a successful no-op, not a failure. */
export class WorkbenchNoChangeError extends Error {
  /** Author-language target, e.g. 素材「海图」. */
  readonly target: string;

  constructor(target: string) {
    super(`${target}已经是所需状态，无需修改`);
    this.name = 'WorkbenchNoChangeError';
    this.target = target;
  }
}

export function requiredText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} 不能为空`);
  return text;
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

export function sameAuthoredName(left: string, right: string): boolean {
  return (
    left.trim().normalize('NFKC').toLocaleLowerCase('en-US') ===
    right.trim().normalize('NFKC').toLocaleLowerCase('en-US')
  );
}
