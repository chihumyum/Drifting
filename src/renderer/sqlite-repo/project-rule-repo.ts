import { v7 as uuidv7 } from 'uuid';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { ProjectRuleTable } from '../schema/drizzle';
import type {
  ChecklistItem,
  ProjectRule,
  RuleKind,
  RuleScope,
  RuleSource,
} from '../domain/project-rule';

export interface CreateRuleInput {
  projectId: string;
  rawContent?: string;
  scope?: RuleScope | null;
  enabled?: boolean;
  source?: RuleSource;
  sourceDriftId?: string | null;
  sourceDriftHash?: string | null;
}

export type UpdateRuleInput = Partial<{
  rawContent: string;
  checklist: ChecklistItem[];
  kind: RuleKind;
  judgingGuide: string;
  compiledFromHash: string;
  scope: RuleScope | null;
  enabled: boolean;
  sourceDriftHash: string | null;
  orderKey: number;
}>;

export interface ProjectRuleRepository {
  create(input: CreateRuleInput): Promise<ProjectRule>;
  update(id: string, updates: UpdateRuleInput): Promise<ProjectRule | null>;
  delete(id: string): Promise<void>;
  findById(id: string): Promise<ProjectRule | null>;
  listByProject(projectId: string): Promise<ProjectRule[]>;
}

function parseChecklist(json: string): ChecklistItem[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as ChecklistItem[]) : [];
  } catch {
    return [];
  }
}

function parseScope(json: string | null): RuleScope | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' ? (v as RuleScope) : null;
  } catch {
    return null;
  }
}

function toDomain(row: typeof ProjectRuleTable.$inferSelect): ProjectRule {
  return {
    id: row.id,
    projectId: row.projectId,
    rawContent: row.rawContent,
    checklist: parseChecklist(row.checklistJson),
    kind: (row.kind as RuleKind) ?? 'other',
    judgingGuide: row.judgingGuide ?? '',
    compiledFromHash: row.compiledFromHash,
    scope: parseScope(row.scopeJson),
    enabled: row.enabled,
    source: row.source === 'drift' ? 'drift' : 'project',
    sourceDriftId: row.sourceDriftId,
    sourceDriftHash: row.sourceDriftHash,
    orderKey: row.orderKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createProjectRuleRepository(): ProjectRuleRepository {
  const create = async (input: CreateRuleInput): Promise<ProjectRule> => {
    const db = getDb();
    const now = new Date().toISOString();
    const row = {
      id: uuidv7(),
      projectId: input.projectId,
      rawContent: input.rawContent ?? '',
      checklistJson: '[]',
      kind: 'other' as RuleKind,
      judgingGuide: '',
      compiledFromHash: '',
      scopeJson: input.scope ? JSON.stringify(input.scope) : null,
      enabled: input.enabled ?? true,
      source: input.source ?? 'project',
      sourceDriftId: input.sourceDriftId ?? null,
      sourceDriftHash: input.sourceDriftHash ?? null,
      orderKey: 0,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(ProjectRuleTable).values(row);
    return toDomain(row as typeof ProjectRuleTable.$inferSelect);
  };

  const update = async (id: string, updates: UpdateRuleInput): Promise<ProjectRule | null> => {
    const db = getDb();
    const setValues: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (updates.rawContent !== undefined) setValues.rawContent = updates.rawContent;
    if (updates.checklist !== undefined) setValues.checklistJson = JSON.stringify(updates.checklist);
    if (updates.kind !== undefined) setValues.kind = updates.kind;
    if (updates.judgingGuide !== undefined) setValues.judgingGuide = updates.judgingGuide;
    if (updates.compiledFromHash !== undefined) setValues.compiledFromHash = updates.compiledFromHash;
    if (updates.scope !== undefined) setValues.scopeJson = updates.scope ? JSON.stringify(updates.scope) : null;
    if (updates.enabled !== undefined) setValues.enabled = updates.enabled;
    if (updates.sourceDriftHash !== undefined) setValues.sourceDriftHash = updates.sourceDriftHash;
    if (updates.orderKey !== undefined) setValues.orderKey = updates.orderKey;

    await db.update(ProjectRuleTable).set(setValues).where(eq(ProjectRuleTable.id, id));
    const rows = await db.select().from(ProjectRuleTable).where(eq(ProjectRuleTable.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const deleteRule = async (id: string): Promise<void> => {
    await getDb().delete(ProjectRuleTable).where(eq(ProjectRuleTable.id, id));
  };

  const findById = async (id: string): Promise<ProjectRule | null> => {
    const rows = await getDb().select().from(ProjectRuleTable).where(eq(ProjectRuleTable.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const listByProject = async (projectId: string): Promise<ProjectRule[]> => {
    const rows = await getDb()
      .select()
      .from(ProjectRuleTable)
      .where(eq(ProjectRuleTable.projectId, projectId))
      .orderBy(asc(ProjectRuleTable.orderKey), asc(ProjectRuleTable.createdAt));
    return rows.map(toDomain);
  };

  return { create, update, delete: deleteRule, findById, listByProject };
}
