export const AGENT_WRITING_INTELLIGENCE_SCHEMA_VERSION = 1 as const;

export type AgentWritingIntentKind =
  | 'answer'
  | 'inspect'
  | 'polish'
  | 'rewrite'
  | 'continue'
  | 'summarize'
  | 'whole_book_qa'
  | 'canon_evolution'
  | 'structural'
  | 'unknown';

export type AgentWritingMutationKind =
  | 'none'
  | 'prose'
  | 'summary'
  | 'canon'
  | 'structural'
  | 'mixed';

export type AgentWritingScopeKind =
  | 'focus_selection'
  | 'focus_block'
  | 'focus_entity'
  | 'explicit'
  | 'whole_book'
  | 'unresolved';

export type AgentAuthoringEntityKind = 'chapter' | 'drift' | 'element' | 'storyline' | 'category';

export interface AgentAuthoringEntity {
  kind: AgentAuthoringEntityKind;
  id: string;
  name: string;
  /** Canonical virtual-workspace prose path. */
  path: string;
}

export interface AgentKnownAuthoringTarget {
  entity: AgentAuthoringEntity;
  /** Product-owned current names and aliases that can resolve this entity. */
  terms: string[];
}

export interface AgentAuthoringFocus {
  projectId: string;
  entity: AgentAuthoringEntity;
  mode: 'selection' | 'block' | 'entity';
  selectedText: string;
  selectedBlocks: Array<{
    id: string;
    ordinal: number;
    text: string;
  }>;
  contextBefore: string[];
  contextAfter: string[];
}

export interface AgentLiteraryStyleProfile {
  sampleChars: number;
  paragraphCount: number;
  medianParagraphChars: number;
  sentenceCount: number;
  averageSentenceChars: number;
  dialogueRatio: number;
  punctuationDensity: number;
  firstPersonDensity: number;
}

export interface AgentWritingTurnContext {
  schemaVersion: typeof AGENT_WRITING_INTELLIGENCE_SCHEMA_VERSION;
  intent: {
    kind: AgentWritingIntentKind;
    mutation: AgentWritingMutationKind;
    scopeKind: AgentWritingScopeKind;
    hardFocusScope: boolean;
    clarificationRequired: boolean;
    ambiguityReasons: string[];
    preservation: {
      plotFacts: boolean;
      canon: boolean;
      chronology: boolean;
      pov: boolean;
      tense: boolean;
      authorVoice: boolean;
    };
    evidence: {
      targetProse: boolean;
      voiceAnchors: boolean;
      canon: boolean;
      exactCitations: boolean;
    };
  };
  focus: AgentAuthoringFocus | null;
  /** Explicitly named product entities, independent of the active editor pane. */
  resolvedTargets: AgentAuthoringEntity[];
  styleProfile: AgentLiteraryStyleProfile | null;
  canonImpact: {
    level: 'none' | 'low' | 'medium' | 'high';
    referencedTerms: string[];
    reasons: string[];
    requiresSanctionedPatch: boolean;
  };
}

const WHOLE_BOOK_RE =
  /(?:全书|整本|整部|全文|所有章节|每(?:一)?章|whole\s+book|entire\s+(?:book|novel)|all\s+chapters)/iu;
const QA_RE =
  /(?:检查|审校|审阅|体检|通读|一致性|连贯性|质量|找问题|找漏洞|review|audit|quality|consisten|continuity|proofread)/iu;
const POLISH_RE = /(?:润色|优化文笔|精修|修辞|polish|line\s*edit|copy\s*edit)/iu;
const REWRITE_RE = /(?:改写|重写|重构这|调整这|修改这|rewrite|rework|revise)/iu;
const CONTINUE_RE =
  /(?:续写|接着写|继续写|补写|扩写|往下写|continue\s+writing|write\s+the\s+next)/iu;
const SUMMARY_RE = /(?:总结|摘要|梗概|概括|summary|summari[sz]e|synopsis)/iu;
const SAVE_SUMMARY_RE =
  /(?:更新|写入|保存|改写|重写|填入).{0,12}(?:总结|摘要|梗概|summary|synopsis)/iu;
const CANON_RE = /(?:设定|canon|世界观|人物关系|关系设定|演化|补丁|element[_\s-]?patch|事实表)/iu;
const CANON_MUTATION_RE =
  /(?:改变|修改|更新|演化|推翻|重设|新增|删除).{0,16}(?:设定|canon|世界观|人物关系|关系设定|事实)/iu;
const RELATION_OPERATION_RE =
  /(?:(?:新增|添加|建立|删除|移除|调整|关联).{0,10}(?:人物)?关系|(?:link|unlink|add|remove|update).{0,10}relation)/iu;
const STRUCTURAL_RE =
  /(?:新建|创建|新增|删除|删掉|移除|移动|重命名|调整关系|添加关系|建立关系|关联章节|create|delete|remove|rename|relation)/iu;
const CREATE_RE = /(?:新建|创建|新增|create|add\s+(?:a|an|the)?)/iu;
const MUTATION_RE =
  /(?:润色|改写|重写|改成|写得|修改|调整|优化|修复|续写|补写|扩写|删掉|删除|新建|创建|新增|写入|替换|合并|拆分|polish|rewrite|rework|revise|edit|fix|continue\s+writing|delete|create|replace)/iu;
const DEICTIC_RE =
  /(?:这里|这段|这一段|这句|这句话|当前段|当前章节|当前章|选中|所选|光标处|this\s+(?:passage|paragraph|sentence|selection|chapter)|selected\s+(?:text|passage))/iu;
const CURRENT_ENTITY_RE = /(?:本章|当前章|当前章节|这一章|this\s+chapter|current\s+chapter)/iu;
const EXPLICIT_TARGET_RE =
  /(?:\/chapters\/|\/drifts\/|\/elements\/|第[〇零一二三四五六七八九十百0-9两]+章|章节[：:]?\s*[^\s，。；]+|《[^》]+》|chapter\s+\d+)/iu;
const PLOT_CHANGE_RE =
  /(?:改变剧情|改剧情|重构情节|推翻情节|另写剧情|彻底重写|自由发挥|change\s+the\s+plot|new\s+plot|from\s+scratch)/iu;
const PRESERVE_PLOT_RE =
  /(?:(?:不要|不得|别|不许|不能).{0,8}(?:改变|改动|修改|调整|重构|推翻)?(?:剧情|情节|事实)|(?:保持|保留).{0,8}(?:剧情|情节|事实))/iu;
const DESTRUCTIVE_RE = /(?:删除|移除|推翻|清空|delete|remove|drop)/iu;
const NON_MUTATING_REQUEST_RE =
  /(?:(?:不要|先别|无需|不用).{0,10}(?:润色|改写|重写|修改|编辑|续写)|(?:只|仅).{0,4}(?:分析|评价|建议|检查|告诉))/iu;
const WRITING_ADVICE_RE =
  /(?:如何|怎么|是否|要不要|该不该|需不需要|有什么建议|how\s+(?:would|should|can)|should\s+I).{0,24}(?:润色|改写|重写|修改|续写|polish|rewrite|edit)?/iu;
const EXPLICIT_WRITING_DIRECTIVE_RE =
  /(?:帮我|请|替我|直接|现在|开始|执行|进行).{0,16}(?:润色|改写|重写|改成|写得|修改|优化|修复|续写|补写|扩写|编辑|polish|rewrite|edit|fix)/iu;

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

export function analyzeAgentLiteraryStyle(
  paragraphs: readonly string[],
): AgentLiteraryStyleProfile | null {
  const normalized = paragraphs.map((value) => value.trim()).filter(Boolean);
  const sample = normalized.join('\n');
  const chars = [...sample.replace(/\s/gu, '')];
  if (chars.length === 0) return null;
  const sentences = sample
    .split(/[。！？!?…]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const dialogueChars = [...sample.matchAll(/[“「『"]([^”」』"]+)[”」』"]/gu)].reduce(
    (total, match) => total + [...(match[1] ?? '')].length,
    0,
  );
  const punctuation = [...sample.matchAll(/[，。！？；：、—…,.!?;:]/gu)].length;
  const firstPerson = [...sample.matchAll(/(?:我|我们|咱们|I|we)\b/giu)].length;
  return {
    sampleChars: chars.length,
    paragraphCount: normalized.length,
    medianParagraphChars: round(median(normalized.map((value) => [...value].length)), 1),
    sentenceCount: Math.max(1, sentences.length),
    averageSentenceChars: round(chars.length / Math.max(1, sentences.length), 1),
    dialogueRatio: round(dialogueChars / chars.length),
    punctuationDensity: round(punctuation / chars.length),
    firstPersonDensity: round(firstPerson / chars.length),
  };
}

function focusScope(focus: AgentAuthoringFocus): AgentWritingScopeKind {
  if (focus.mode === 'selection') return 'focus_selection';
  if (focus.mode === 'block') return 'focus_block';
  return 'focus_entity';
}

function classifyIntent(prompt: string): {
  kind: AgentWritingIntentKind;
  mutation: AgentWritingMutationKind;
} {
  const wholeBook = WHOLE_BOOK_RE.test(prompt);
  const qa = QA_RE.test(prompt);
  const mutation = MUTATION_RE.test(prompt);
  const explicitlyNonMutating = NON_MUTATING_REQUEST_RE.test(prompt);
  if (wholeBook && qa && explicitlyNonMutating) {
    return { kind: 'whole_book_qa', mutation: 'none' };
  }
  if (
    explicitlyNonMutating ||
    (WRITING_ADVICE_RE.test(prompt) && !EXPLICIT_WRITING_DIRECTIVE_RE.test(prompt))
  ) {
    return { kind: 'inspect', mutation: 'none' };
  }
  if (wholeBook && qa && !mutation) return { kind: 'whole_book_qa', mutation: 'none' };
  if (wholeBook && qa && mutation) return { kind: 'whole_book_qa', mutation: 'mixed' };
  if (RELATION_OPERATION_RE.test(prompt)) {
    return { kind: 'structural', mutation: 'structural' };
  }
  if (CANON_MUTATION_RE.test(prompt)) return { kind: 'canon_evolution', mutation: 'canon' };
  if (POLISH_RE.test(prompt)) return { kind: 'polish', mutation: 'prose' };
  if (CONTINUE_RE.test(prompt)) return { kind: 'continue', mutation: 'prose' };
  if (REWRITE_RE.test(prompt) || /(?:改成|写得)/iu.test(prompt)) {
    return { kind: 'rewrite', mutation: 'prose' };
  }
  if (SUMMARY_RE.test(prompt)) {
    return {
      kind: 'summarize',
      mutation: SAVE_SUMMARY_RE.test(prompt) ? 'summary' : 'none',
    };
  }
  if (STRUCTURAL_RE.test(prompt)) return { kind: 'structural', mutation: 'structural' };
  if (qa || /(?:分析|评价|看看|inspect|analy[sz]e|explain)/iu.test(prompt)) {
    return { kind: 'inspect', mutation: 'none' };
  }
  if (mutation) return { kind: 'unknown', mutation: 'mixed' };
  return { kind: 'answer', mutation: 'none' };
}

export function buildAgentWritingTurnContext(
  prompt: string,
  focus: AgentAuthoringFocus | null,
  knownCanonTerms: readonly string[] = [],
  knownTargets: readonly AgentKnownAuthoringTarget[] = [],
): AgentWritingTurnContext {
  const classified = classifyIntent(prompt);
  const wholeBook = WHOLE_BOOK_RE.test(prompt);
  const resolvedTargets = knownTargets
    .filter((target) =>
      target.terms.some((term) => term.trim().length >= 2 && prompt.includes(term.trim())),
    )
    .map((target) => target.entity)
    .filter(
      (target, index, targets) =>
        targets.findIndex(
          (candidate) => candidate.kind === target.kind && candidate.id === target.id,
        ) === index,
    );
  const explicitTarget = EXPLICIT_TARGET_RE.test(prompt) || resolvedTargets.length > 0;
  const deictic = DEICTIC_RE.test(prompt);
  const currentEntity = CURRENT_ENTITY_RE.test(prompt);
  const mutating = classified.mutation !== 'none';
  const createsResource = classified.kind === 'structural' && CREATE_RE.test(prompt);
  const requiresExistingScope = mutating && !createsResource;
  let scopeKind: AgentWritingScopeKind;
  let hardFocusScope = false;
  const ambiguityReasons: string[] = [];

  if (wholeBook) {
    scopeKind = 'whole_book';
  } else if (focus && (deictic || currentEntity || (requiresExistingScope && !explicitTarget))) {
    scopeKind = currentEntity ? 'focus_entity' : focusScope(focus);
    hardFocusScope = mutating;
  } else if (explicitTarget) {
    scopeKind = 'explicit';
  } else if (focus && !mutating) {
    scopeKind = focusScope(focus);
  } else {
    scopeKind = 'unresolved';
  }

  if (requiresExistingScope && deictic && !focus) {
    ambiguityReasons.push(
      'The request points to nearby/selected text, but no editor focus exists.',
    );
  }
  if (requiresExistingScope && !focus && !wholeBook && !explicitTarget) {
    ambiguityReasons.push('The requested mutation has no resolvable target scope.');
  }
  const clarificationRequired = ambiguityReasons.length > 0;
  const plotMayChange = !PRESERVE_PLOT_RE.test(prompt) && PLOT_CHANGE_RE.test(prompt);
  const proseQuality =
    classified.kind === 'polish' || classified.kind === 'rewrite' || classified.kind === 'continue';
  const referencedTerms = [
    ...new Set(
      knownCanonTerms
        .map((term) => term.trim())
        .filter((term) => term.length >= 2 && prompt.includes(term)),
    ),
  ]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .reduce<string[]>((selected, term) => {
      if (!selected.some((existing) => existing.includes(term))) selected.push(term);
      return selected;
    }, [])
    .slice(0, 32);
  const canonImpactReasons: string[] = [];
  let canonImpactLevel: AgentWritingTurnContext['canonImpact']['level'] = 'none';
  if (mutating) {
    canonImpactLevel = 'low';
    if (classified.kind === 'rewrite' || classified.kind === 'continue') {
      canonImpactLevel = 'medium';
      canonImpactReasons.push('The request may change story facts or character state.');
    }
    if (referencedTerms.length > 0) {
      if (canonImpactLevel === 'low') canonImpactLevel = 'medium';
      canonImpactReasons.push('The request names established project entities.');
    }
    if (
      classified.kind === 'canon_evolution' ||
      classified.kind === 'structural' ||
      DESTRUCTIVE_RE.test(prompt)
    ) {
      canonImpactLevel = 'high';
      canonImpactReasons.push('The request changes authored truth or project structure.');
    }
  }
  const requiresSanctionedPatch =
    classified.kind === 'canon_evolution' ||
    (!PRESERVE_PLOT_RE.test(prompt) && PLOT_CHANGE_RE.test(prompt) && referencedTerms.length > 0);

  return {
    schemaVersion: AGENT_WRITING_INTELLIGENCE_SCHEMA_VERSION,
    intent: {
      ...classified,
      scopeKind,
      hardFocusScope,
      clarificationRequired,
      ambiguityReasons,
      preservation: {
        plotFacts: mutating && !plotMayChange,
        canon: classified.kind !== 'canon_evolution',
        chronology: classified.kind !== 'canon_evolution',
        pov: proseQuality,
        tense: proseQuality,
        authorVoice: proseQuality,
      },
      evidence: {
        targetProse: mutating || classified.kind !== 'answer',
        voiceAnchors: proseQuality,
        canon: mutating || classified.kind === 'whole_book_qa' || CANON_RE.test(prompt),
        exactCitations:
          classified.kind === 'summarize' ||
          classified.kind === 'whole_book_qa' ||
          classified.kind === 'inspect',
      },
    },
    focus,
    resolvedTargets,
    styleProfile: focus
      ? analyzeAgentLiteraryStyle([
          ...focus.contextBefore,
          ...focus.selectedBlocks.map((block) => block.text),
          ...focus.contextAfter,
        ])
      : null,
    canonImpact: {
      level: canonImpactLevel,
      referencedTerms,
      reasons: canonImpactReasons,
      requiresSanctionedPatch,
    },
  };
}

function clipped(value: string, max: number): string {
  const clean = value.replaceAll('\u0000', '').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function renderBlocks(blocks: readonly { ordinal: number; text: string }[]): string[] {
  return blocks.flatMap((block) => {
    const text = clipped(block.text, 2_000);
    return text ? [`- 段 ${block.ordinal}: ${text}`] : [];
  });
}

export function renderAgentWritingSystemSection(
  context: AgentWritingTurnContext | undefined,
): string[] {
  if (!context) return [];
  const { intent, focus, styleProfile } = context;
  const lines = [
    'Authoring-intent contract (product-derived; the exact author request remains authoritative):',
    `- intent=${intent.kind}; mutation=${intent.mutation}; scope=${intent.scopeKind}`,
  ];
  if (intent.clarificationRequired) {
    lines.push(
      '- The mutation target is unresolved. Do not write. Ask one focused scope question with ask_user before any mutation.',
      ...intent.ambiguityReasons.map((reason) => `- ambiguity: ${reason}`),
    );
  }
  const preserved = Object.entries(intent.preservation)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  if (preserved.length > 0) {
    lines.push(`- Preserve unless the author explicitly overrides it: ${preserved.join(', ')}.`);
  }
  if (intent.evidence.exactCitations) {
    lines.push(
      '- Every semantic summary or QA verdict must cite exact current source passages; distinguish fact, inference, and unresolved uncertainty.',
    );
  }
  if (intent.kind === 'whole_book_qa') {
    lines.push(
      intent.mutation === 'none'
        ? '- This is review work. Create the durable plan with workKind=review. Each completed chapter step needs a structured reviewResult with exact citations; do not manufacture manuscript writes merely to satisfy progress tracking.'
        : '- This request combines whole-book diagnosis and mutation. Create workKind=edit, cite the diagnosed source, and prove each completed chapter through its accepted manuscript write; do not label an unedited finding as completed edit work.',
    );
  }
  if (intent.kind === 'canon_evolution') {
    lines.push(
      '- Canon change is explicit. Record sanctioned canon/patch evolution and its temporal scope; never make prose the only record of the new truth.',
    );
  }
  if (context.canonImpact.level === 'high') {
    lines.push(
      `- Canon impact is high${context.canonImpact.referencedTerms.length > 0 ? ` for: ${context.canonImpact.referencedTerms.join(', ')}` : ''}. Read current canon and affected prose before mutating.`,
    );
  }
  if (context.canonImpact.requiresSanctionedPatch) {
    lines.push(
      '- The product impact analysis requires a sanctioned temporal canon patch/evolution record before prose may embody the changed truth.',
    );
  }
  if (focus) {
    lines.push(
      `Current editor focus: ${focus.entity.kind} ${JSON.stringify(focus.entity.name)} at ${focus.entity.path}.`,
      `Focus mode: ${focus.mode}; selected block ordinals: ${focus.selectedBlocks.map((block) => block.ordinal).join(', ') || '(none)'}.`,
    );
    if (intent.hardFocusScope) {
      lines.push(
        '- This focus is the hard mutation boundary. Do not modify another entity or text outside the selected span/block. Scope broadening requires an explicit new turn so the product can bind a new immutable boundary.',
      );
    }
    if (focus.contextBefore.length > 0) {
      lines.push(
        'Nearby prose before the focus:',
        ...focus.contextBefore.map((text) => `- ${clipped(text, 2_000)}`),
      );
    }
    if (focus.selectedBlocks.length > 0) {
      lines.push('Focused prose:', ...renderBlocks(focus.selectedBlocks));
    }
    if (focus.mode === 'selection' && focus.selectedText) {
      lines.push(`Exact selected span: ${JSON.stringify(clipped(focus.selectedText, 8_000))}`);
    }
    if (focus.contextAfter.length > 0) {
      lines.push(
        'Nearby prose after the focus:',
        ...focus.contextAfter.map((text) => `- ${clipped(text, 2_000)}`),
      );
    }
  }
  if (context.resolvedTargets.length > 0) {
    lines.push(
      'Product-resolved explicit manuscript targets:',
      ...context.resolvedTargets.map(
        (target) => `- ${target.kind} ${JSON.stringify(target.name)} at ${target.path}`,
      ),
      '- These are the complete named prose targets for this turn. Do not substitute another entity with a similar name.',
    );
  }
  if (styleProfile && intent.evidence.voiceAnchors) {
    lines.push(
      `Local voice witness: ${styleProfile.paragraphCount} paragraphs / ${styleProfile.sampleChars} chars; median paragraph ${styleProfile.medianParagraphChars} chars; average sentence ${styleProfile.averageSentenceChars} chars; dialogue ratio ${styleProfile.dialogueRatio}. Treat nearby prose as the primary voice evidence, not these metrics as a formula.`,
    );
  }
  return lines;
}

export const AGENT_WRITING_INTELLIGENCE_CONTRACT = {
  authoringFocus: 'focused-editor-entity-selection-block-and-nearby-prose',
  explicitTargetResolution: 'product-owned-current-name-alias-to-canonical-entity-set',
  ambiguityPolicy: 'unresolved-deictic-mutation-blocks-write-and-asks-user',
  scopePolicy: 'focus-bound-prose-write-fails-closed-outside-exact-span-or-block',
  defaultRewritePreservation: 'plot-canon-chronology-pov-tense-author-voice',
  voiceEvidence: 'exact-nearby-prose-plus-diagnostic-style-profile',
  canonPolicy: 'authored-canon-and-temporal-patch-only',
  canonProseGate: 'patch-required-prose-mutation-fails-closed-until-new-author-turn',
  reviewTaskEvidence: 'exact-target-read-plus-structured-cited-review-result',
  semanticSummary: 'claim-kind-plus-exact-source-citations',
} as const;
