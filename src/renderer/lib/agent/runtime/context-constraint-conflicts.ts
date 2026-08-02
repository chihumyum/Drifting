import type { AgentContextConstraintLedgerEntry, AgentContextSourceRow } from './context-planner';
import { tokenizeAgentContextEvidenceQuery } from './context-evidence-retrieval';

export interface AgentContextConstraintConflict {
  conflictId: string;
  kind: 'fact_value' | 'instruction_veto';
  leftSourceId: string;
  rightSourceId: string;
  reason: string;
  requiresAuthorConfirmation: true;
}

interface FactSignature {
  subject: string;
  key: string;
  value: string;
  correction: boolean;
}

const FACT_PATTERN =
  /^(.{1,40}?)(?:的)?(年龄|身份|姓名|名字|眼睛|瞳色|发色|能力限制|能力|关系|性格|视角|时态|称呼|地点|时间)(?:必须)?(?:是|为|改为|设为|应该是|应为)(.{1,120})$/u;
const GENERIC_FACT_PATTERN = /^(.{1,32}?)(?:是|为)(.{1,120})$/u;
const CORRECTION = /^(?:更正|纠正|修正|以此为准|此前说错了)\s*[：:]?/u;
const POSITIVE_MODAL = /^(?:必须|务必|始终|永远|只允许|要求|请保持)\s*/u;
const NEGATIVE_MODAL = /^(?:不得|禁止|不要|别再?|不能|绝不|请勿|不希望|拒绝|避免)\s*/u;

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\s，。；：、！？,.!?;:'"“”‘’（）()【】[\]]+/gu, '');
}

function factSignature(content: string): FactSignature | null {
  const correction = CORRECTION.test(content.trim());
  const stripped = content
    .trim()
    .replace(CORRECTION, '')
    .replace(/[。！？!?]+$/u, '');
  const specific = FACT_PATTERN.exec(stripped);
  if (specific) {
    return {
      subject: normalized(specific[1]!),
      key: normalized(specific[2]!),
      value: normalized(specific[3]!),
      correction,
    };
  }
  const generic = GENERIC_FACT_PATTERN.exec(stripped);
  if (!generic) return null;
  return {
    subject: normalized(generic[1]!),
    key: 'is',
    value: normalized(generic[2]!),
    correction,
  };
}

function ruleTerms(content: string): Set<string> {
  const stripped = content.trim().replace(POSITIVE_MODAL, '').replace(NEGATIVE_MODAL, '');
  return new Set(
    tokenizeAgentContextEvidenceQuery(stripped).filter(
      (term) => term.length > 1 && !/^(?:必须|不得|不要|不能|始终|永远)$/u.test(term),
    ),
  );
}

function relatedRules(left: string, right: string): boolean {
  const a = ruleTerms(left);
  const b = ruleTerms(right);
  if (a.size === 0 || b.size === 0) return false;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  return intersection / Math.min(a.size, b.size) >= 0.6;
}

function conflictId(
  kind: AgentContextConstraintConflict['kind'],
  leftSourceId: string,
  rightSourceId: string,
): string {
  return `context-conflict:${kind}:${encodeURIComponent(leftSourceId)}:${encodeURIComponent(rightSourceId)}`;
}

/** High-confidence, provider-free contradiction detection only. */
export function detectAgentContextConstraintConflicts(input: {
  sourceRows: readonly AgentContextSourceRow[];
  ledger: readonly AgentContextConstraintLedgerEntry[];
}): AgentContextConstraintConflict[] {
  const rowById = new Map(input.sourceRows.map((row) => [row.sourceId, row] as const));
  const ordered = input.ledger
    .map((entry) => ({ entry, row: rowById.get(entry.sourceId) }))
    .filter(
      (item): item is { entry: AgentContextConstraintLedgerEntry; row: AgentContextSourceRow } =>
        item.row?.kind === 'user',
    )
    .sort((left, right) => left.row.ordinal - right.row.ordinal);
  const conflicts: AgentContextConstraintConflict[] = [];
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const left = ordered[leftIndex]!;
      const right = ordered[rightIndex]!;
      if (right.entry.kind === 'author_fact' && left.entry.kind === 'author_fact') {
        const a = factSignature(left.row.content);
        const b = factSignature(right.row.content);
        // An explicit later correction is already an author decision, not an
        // ambiguity that should interrupt the task again.
        if (
          a &&
          b &&
          !b.correction &&
          a.subject === b.subject &&
          a.key === b.key &&
          a.value !== b.value
        ) {
          conflicts.push({
            conflictId: conflictId('fact_value', left.row.sourceId, right.row.sourceId),
            kind: 'fact_value',
            leftSourceId: left.row.sourceId,
            rightSourceId: right.row.sourceId,
            reason: `Two author facts assign different values to ${b.subject}${b.key === 'is' ? '' : `/${b.key}`}.`,
            requiresAuthorConfirmation: true,
          });
        }
      }
      const oppositeRuleKinds =
        (left.entry.kind === 'author_instruction' && right.entry.kind === 'author_veto') ||
        (left.entry.kind === 'author_veto' && right.entry.kind === 'author_instruction');
      if (oppositeRuleKinds && relatedRules(left.row.content, right.row.content)) {
        conflicts.push({
          conflictId: conflictId('instruction_veto', left.row.sourceId, right.row.sourceId),
          kind: 'instruction_veto',
          leftSourceId: left.row.sourceId,
          rightSourceId: right.row.sourceId,
          reason: 'An author instruction and veto refer to the same action.',
          requiresAuthorConfirmation: true,
        });
      }
    }
  }
  return conflicts;
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findConfirmationPayload(value: unknown): Record<string, unknown> | null {
  const object = nestedRecord(value);
  if (!object) return null;
  if (Array.isArray(object.confirmedConstraintConflictIds)) return object;
  for (const child of Object.values(object)) {
    const found = findConfirmationPayload(child);
    if (found) return found;
  }
  return null;
}

/** Author answers returned by ask_user are durable canonical tool evidence. */
export function confirmedAgentContextConstraintConflictIds(
  sourceRows: readonly AgentContextSourceRow[],
): Set<string> {
  const confirmed = new Set<string>();
  for (const row of sourceRows) {
    if (row.kind !== 'tool_result' || row.toolName !== 'ask_user') continue;
    try {
      const outer = nestedRecord(JSON.parse(row.content));
      if (!outer || outer.ok !== true || typeof outer.content !== 'string') continue;
      const payload = findConfirmationPayload(JSON.parse(outer.content));
      if (!payload || typeof payload.answer !== 'string' || !payload.answer.trim()) continue;
      for (const conflictId of payload.confirmedConstraintConflictIds as unknown[]) {
        if (typeof conflictId === 'string' && conflictId) confirmed.add(conflictId);
      }
    } catch {
      // Canonical bridge validation owns malformed tool rows. This helper only
      // declines to treat an unrecognized result as author confirmation.
    }
  }
  return confirmed;
}
