import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import type { AgentContextSupplementalPinnedRow } from './context-message-adapter';
import { describeAgentWriteTarget } from './workspace-domain-language';
import { workspaceAuthoredReadStateFromArguments } from './drifting-workspace-tool-runtime';
import { projectAuthoredTextForModel } from './workspace-prose-file';

const MAX_FEEDBACK_ITEMS = 20;

function writeCoverage(
  effect: {
    turnId: string;
    callId?: string;
    toolName: string;
  },
  turnOrdinal: number,
  enabled = true,
) {
  return enabled && typeof effect.callId === 'string' && effect.callId.length > 0
    ? [
        {
          turnId: effect.turnId,
          turnOrdinal,
          callId: effect.callId,
          toolName: effect.toolName,
        },
      ]
    : [];
}

/**
 * First-class context rows for durable write settlement receipts.
 *
 * These rows retain canonical provenance and remain semantically pinned by the
 * context planner. History is bounded because committed domain state must be
 * re-read through tools rather than growing an eternal prompt log.
 */
export async function loadAgentWriteReviewContextRows(
  sessionId: string,
  repository: AgentRuntimeWriteEffectRepository = createAgentRuntimeWriteEffectRepository(),
  options: { currentTurnId?: string } = {},
): Promise<AgentContextSupplementalPinnedRow[]> {
  if (!sessionId) return [];
  const snapshot = await repository.loadSnapshot(sessionId);
  const effects = new Map(snapshot.effects.map((effect) => [effect.id, effect]));
  const eligible = snapshot.reviews
    .filter((review) => effects.has(review.effectId))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  const byTarget = new Map<
    string,
    Array<{
      review: (typeof eligible)[number];
      effect: (typeof snapshot.effects)[number];
      turnOrdinal: number;
      coverage: ReturnType<typeof writeCoverage>;
    }>
  >();
  for (const review of eligible) {
    const effect = effects.get(review.effectId)!;
    const turnOrdinal =
      snapshot.turnContextOrdinalsById?.[effect.turnId] ??
      snapshot.turnOrdinalsById?.[effect.turnId];
    if (turnOrdinal === undefined || !Number.isSafeInteger(turnOrdinal) || turnOrdinal < 0) {
      throw new Error(
        `Write review ${review.id} has no canonical turn ordinal for ${effect.turnId}.`,
      );
    }
    const target = describeAgentWriteTarget(effect.toolName, effect.arguments);
    const rows = byTarget.get(target) ?? [];
    const toolPairIsCanonical = snapshot.turnHasCanonicalHistoryById?.[effect.turnId] ?? true;
    rows.push({
      review,
      effect,
      turnOrdinal,
      coverage: writeCoverage(
        effect,
        turnOrdinal,
        toolPairIsCanonical || effect.turnId === options.currentTurnId,
      ),
    });
    byTarget.set(target, rows);
  }

  const targetStates = [...byTarget.entries()]
    .map(([target, rows]) => {
      const latest = [...rows].sort(
        (left, right) =>
          left.review.updatedAt.localeCompare(right.review.updatedAt) ||
          left.review.id.localeCompare(right.review.id),
      )[rows.length - 1]!;
      return {
        target,
        latest,
        coverage: uniqueWriteCoverage(rows.flatMap((row) => row.coverage)),
      };
    })
    .sort(
      (left, right) =>
        left.latest.review.updatedAt.localeCompare(right.latest.review.updatedAt) ||
        left.latest.review.id.localeCompare(right.latest.review.id),
    );
  const exactStates = targetStates.slice(-MAX_FEEDBACK_ITEMS);
  const archivedStates = targetStates.slice(0, -MAX_FEEDBACK_ITEMS);
  const exactRows: AgentContextSupplementalPinnedRow[] = exactStates.map((state) => ({
    sourceId: `write-review:${state.latest.review.id}`,
    turnOrdinal: state.latest.turnOrdinal,
    kind: 'write_review',
    content: modelFacingReviewState(
      state.latest.effect,
      unresolvedModelFacingRemainingWork(state.latest.effect.arguments, snapshot.effects),
    ),
    durableWriteCoverage: state.coverage,
  }));
  if (archivedStates.length === 0) return exactRows;
  return [
    {
      sourceId: `write-review:${sessionId}:current-state-archive`,
      turnOrdinal: Math.max(...archivedStates.map((state) => state.latest.turnOrdinal)),
      kind: 'write_review',
      content:
        `执行进度中已有可靠完成证据的对象：${summarizeDomainTargets(archivedStates.map((state) => state.target))}。` +
        '这些记录证明所列改动已保存。',
      durableWriteCoverage: uniqueWriteCoverage(archivedStates.flatMap((state) => state.coverage)),
    },
    ...exactRows,
  ];
}

function uniqueWriteCoverage(
  values: readonly { turnId: string; turnOrdinal: number; callId: string; toolName: string }[],
): Array<{ turnId: string; turnOrdinal: number; callId: string; toolName: string }> {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify([value.turnId, value.callId, value.toolName]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One bounded, first-class receipt row for writes whose result is already
 * durable in SQLite. Its provider-visible body stays small while the
 * out-of-band provenance covers every matching canonical tool pair. This lets
 * the planner compact old create/update/delete calls without pretending that
 * the effects were merely conversational history.
 *
 * Effects with a settlement receipt are represented by their own pinned
 * semantic review row rather than duplicated here. Failed/uncertain writes are
 * never covered.
 */
export async function loadAgentDurableWriteReceiptContextRows(
  sessionId: string,
  repository: AgentRuntimeWriteEffectRepository = createAgentRuntimeWriteEffectRepository(),
  options: { currentTurnId?: string } = {},
): Promise<AgentContextSupplementalPinnedRow[]> {
  if (!sessionId) return [];
  const snapshot = await repository.loadSnapshot(sessionId);
  const reviewedEffectIds = new Set(
    snapshot.reviews.map((review) => review.effectId),
  );
  const committed = snapshot.effects
    .filter(
      (effect) =>
        effect.phase === 'result_committed' &&
        effect.callId.length > 0 &&
        !reviewedEffectIds.has(effect.id),
    )
    .map((effect) => {
      const turnOrdinal =
        snapshot.turnContextOrdinalsById?.[effect.turnId] ??
        snapshot.turnOrdinalsById?.[effect.turnId];
      if (turnOrdinal === undefined || !Number.isSafeInteger(turnOrdinal) || turnOrdinal < 0) {
        throw new Error(
          `Committed write effect ${effect.id} has no canonical turn ordinal for ${effect.turnId}.`,
        );
      }
      const toolPairIsCanonical =
        (snapshot.turnHasCanonicalHistoryById?.[effect.turnId] ?? true) ||
        effect.turnId === options.currentTurnId;
      return { effect, turnOrdinal, toolPairIsCanonical };
    })
    .sort(
      (left, right) =>
        left.turnOrdinal - right.turnOrdinal ||
        left.effect.updatedAt.localeCompare(right.effect.updatedAt) ||
        left.effect.id.localeCompare(right.effect.id),
    );
  if (committed.length === 0) return [];

  const latestTurnOrdinal = Math.max(...committed.map((item) => item.turnOrdinal));
  const latestCommittedByTarget = new Map<string, (typeof committed)[number]>();
  for (const item of committed) {
    latestCommittedByTarget.set(
      describeAgentWriteTarget(item.effect.toolName, item.effect.arguments),
      item,
    );
  }
  const latestCommitted = [...latestCommittedByTarget.values()];
  const targets = latestCommitted.map(({ effect }) => durableDomainState(effect));
  const remainingWork = latestCommitted.flatMap(({ effect }) => {
    const summary = unresolvedModelFacingRemainingWork(effect.arguments, snapshot.effects);
    return summary ? [summary] : [];
  });

  return [
    {
      sourceId: `write-receipt:${sessionId}:committed-archive`,
      turnOrdinal: latestTurnOrdinal,
      kind: 'write_receipt',
      content:
        `执行进度中已有可靠完成证据的对象：${summarizeDomainTargets(targets)}。` +
        (remainingWork.length > 0
          ? `当前尚需处理：${summarizeDomainTargets(remainingWork)}。`
          : '') +
        '这些记录证明所列改动已保存。',
      durableWriteCoverage: committed.flatMap(({ effect, turnOrdinal, toolPairIsCanonical }) =>
        toolPairIsCanonical
          ? [
              {
                turnId: effect.turnId,
                turnOrdinal,
                callId: effect.callId,
                toolName: effect.toolName,
              },
            ]
          : [],
      ),
    },
  ];
}

/**
 * Current-turn authored reading is a domain fact, not raw tool history. When a
 * complete body read is followed by one or more durable writes, keep a small
 * current-state note after the obsolete prose/tool rows are retired. Later
 * summary writes in the same turn update the note without erasing the fact
 * that the body was already read.
 */
export async function loadAgentAuthoredReadProgressContextRows(
  sessionId: string,
  repository: AgentRuntimeWriteEffectRepository = createAgentRuntimeWriteEffectRepository(),
  options: { currentTurnId?: string } = {},
): Promise<AgentContextSupplementalPinnedRow[]> {
  if (!sessionId || !options.currentTurnId) return [];
  const snapshot = await repository.loadSnapshot(sessionId);
  const candidates = snapshot.effects
    .filter(
      (effect) =>
        effect.turnId === options.currentTurnId &&
        effect.phase === 'result_committed',
    )
    .flatMap((effect) => {
      const state = workspaceAuthoredReadStateFromArguments(effect.arguments);
      if (!state) return [];
      const turnOrdinal =
        snapshot.turnContextOrdinalsById?.[effect.turnId] ??
        snapshot.turnOrdinalsById?.[effect.turnId];
      if (turnOrdinal === undefined || !Number.isSafeInteger(turnOrdinal) || turnOrdinal < 0) {
        throw new Error(
          `Authored read progress ${effect.id} has no canonical turn ordinal for ${effect.turnId}.`,
        );
      }
      return [{ effect, state, turnOrdinal }];
    })
    .sort(
      (left, right) =>
        left.turnOrdinal - right.turnOrdinal ||
        left.effect.updatedAt.localeCompare(right.effect.updatedAt) ||
        left.effect.id.localeCompare(right.effect.id),
    );
  const byTarget = new Map<
    string,
    {
      target: string;
      summary: string;
      completeBodyRead: boolean;
      focusedBodyEdit: boolean;
      currentPassages: string[];
      turnOrdinal: number;
      sourceEffectId: string;
    }
  >();
  for (const candidate of candidates) {
    const previous = byTarget.get(candidate.state.targetKey);
    byTarget.set(candidate.state.targetKey, {
      target: candidate.state.target,
      summary: candidate.state.summary,
      completeBodyRead: (previous?.completeBodyRead ?? false) || candidate.state.completeBodyRead,
      focusedBodyEdit: (previous?.focusedBodyEdit ?? false) || candidate.state.focusedBodyEdit,
      currentPassages: uniqueStrings([
        ...(previous?.currentPassages ?? []),
        ...candidate.state.currentPassages,
      ]).slice(-12),
      turnOrdinal: candidate.turnOrdinal,
      sourceEffectId: candidate.effect.id,
    });
  }
  return [...byTarget.values()]
    .filter((state) => state.completeBodyRead)
    .slice(-MAX_FEEDBACK_ITEMS)
    .map((state) => {
      const summary = [...state.summary.replace(/\s+/gu, ' ').trim()].slice(0, 1_200).join('');
      const passages = state.focusedBodyEdit
        ? state.currentPassages
            .map((passage) =>
              projectAuthoredTextForModel(passage).text.replace(/\s+/gu, ' ').trim(),
            )
            .filter(Boolean)
            .slice(-8)
        : [];
      return {
        sourceId: `read-progress:${state.sourceEffectId}`,
        turnOrdinal: state.turnOrdinal,
        kind: 'read_progress' as const,
        content:
          `${state.target}已在本轮完整通读，之后的修改已经计入当前稿件。` +
          (summary ? `当前摘要：${withSentenceTerminal(summary)}` : '当前摘要为空。') +
          (passages.length > 0
            ? `当前修改后的正文片段：${passages
                .map((passage) => `「${[...passage].slice(0, 320).join('')}」`)
                .join('；')}。`
            : '') +
          '以上为阅读进度与当前稿件摘要，非完整正文。',
      };
    });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function withSentenceTerminal(value: string): string {
  return /[。！？…!?]$/u.test(value) ? value : `${value}。`;
}

function modelFacingReviewState(
  effect: { toolName: string; arguments: unknown },
  remaining: string | null = modelFacingRemainingWork(effect.arguments),
): string {
  const target = describeAgentWriteTarget(effect.toolName, effect.arguments);
  return remaining
    ? `${target}当前已保存的部分属于稿件。仍待完成：${remaining}。`
    : `${target}已有可靠完成证据并属于当前稿件。`;
}

function summarizeDomainTargets(targets: readonly string[]): string {
  const unique = [...new Set(targets)];
  const visible = unique.slice(0, 12);
  const hidden = unique.length - visible.length;
  return `${visible.join('、') || '作品内容'}${hidden > 0 ? `等另 ${hidden} 项` : ''}`;
}

function durableDomainState(effect: { toolName: string; arguments: unknown }): string {
  const target = describeAgentWriteTarget(effect.toolName, effect.arguments);
  return `${target}${isDurableDelete(effect) ? '已删除' : '已保存'}`;
}

function isDurableDelete(effect: { toolName: string; arguments: unknown }): boolean {
  if (/^(?:delete|remove)_/u.test(effect.toolName)) return true;
  if (
    !effect.arguments ||
    typeof effect.arguments !== 'object' ||
    Array.isArray(effect.arguments)
  ) {
    return false;
  }
  const command = (effect.arguments as Record<string, unknown>).__workspaceCommand;
  if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
  const name = (command as Record<string, unknown>).name;
  return typeof name === 'string' && /^(?:delete|remove)_/u.test(name);
}

function modelFacingRemainingWork(arguments_: unknown): string | null {
  return (
    modelFacingWorkField(arguments_) ??
    (hiddenSummaryWasCleared(arguments_) ? '当前摘要为空，需要补写' : null)
  );
}

function unresolvedModelFacingRemainingWork(
  arguments_: unknown,
  effects: readonly {
    toolName: string;
    arguments: unknown;
    phase?: string;
  }[],
): string | null {
  const remaining = modelFacingRemainingWork(arguments_);
  if (!remaining) return null;
  const deferred = deferredSummaryRequest(arguments_);
  if (!deferred) return remaining;
  const fulfilled = effects.some((effect) => {
    if (effect.phase !== undefined && effect.phase !== 'result_committed') return false;
    if (describeAgentWriteTarget(effect.toolName, effect.arguments) !== deferred.target) {
      return false;
    }
    return authoredSummaryValue(effect.arguments) === deferred.summary;
  });
  return fulfilled ? null : remaining;
}

function deferredSummaryRequest(arguments_: unknown): { target: string; summary: string } | null {
  if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return null;
  const value = (arguments_ as Record<string, unknown>).remainingWork;
  if (typeof value !== 'string') return null;
  const match = value.match(/((?:要素|故事线)「[^」]+」摘要)仍需单独更新为：([\s\S]+)$/u);
  if (!match?.[1] || !match[2]) return null;
  return {
    target: match[1].trim(),
    summary: normalizeAuthoredValue(match[2]),
  };
}

function authoredSummaryValue(arguments_: unknown): string | null {
  if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return null;
  const record = arguments_ as Record<string, unknown>;
  for (const key of ['content', 'summary', 'body'] as const) {
    if (typeof record[key] === 'string') return normalizeAuthoredValue(record[key]);
  }
  const command = record.__workspaceCommand;
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  const commandArguments = (command as Record<string, unknown>).arguments;
  if (
    !commandArguments ||
    typeof commandArguments !== 'object' ||
    Array.isArray(commandArguments)
  ) {
    return null;
  }
  const summary = (commandArguments as Record<string, unknown>).summary;
  return typeof summary === 'string' ? normalizeAuthoredValue(summary) : null;
}

function normalizeAuthoredValue(value: string): string {
  return value
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[。；;\s]+$/u, '');
}

/**
 * Repair receipts written by older runtimes that mislabeled a full summary
 * clear as "summary synchronized". The hidden command is durable evidence of
 * the resulting authored value, so this inference is reconstructible rather
 * than a heuristic over model prose.
 */
function hiddenSummaryWasCleared(arguments_: unknown): boolean {
  if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return false;
  const command = (arguments_ as Record<string, unknown>).__workspaceCommand;
  if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
  const commandRecord = command as Record<string, unknown>;
  if (commandRecord.name !== 'set_node_summary') return false;
  const commandArguments = commandRecord.arguments;
  if (
    !commandArguments ||
    typeof commandArguments !== 'object' ||
    Array.isArray(commandArguments)
  ) {
    return false;
  }
  return (commandArguments as Record<string, unknown>).summary === '';
}

function modelFacingWorkField(arguments_: unknown): string | null {
  if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return null;
  const value = (arguments_ as Record<string, unknown>).remainingWork;
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/gu, ' ').trim().slice(0, 240);
  if (
    !compact ||
    /(?:局部修改|正文已变化|目标已不在|重新定位|跳过|未重复执行)/u.test(compact) ||
    /\b(?:stale|skipped|not found|already changed|local edit)\b/iu.test(compact) ||
    /\b(?:json|path|revision|receipt|writeref|yjs|sqlite)\b/iu.test(
      compact,
    )
  ) {
    return null;
  }
  return compact.replace(/[。；;\s]+$/u, '');
}
