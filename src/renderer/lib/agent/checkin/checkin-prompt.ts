/**
 * Project Home check-in: one read-only model request that turns the author's
 * recent changes into a few cards. It writes nothing: memory upkeep, like
 * every other piece of work, is a card the author opens. The prompt states
 * principles only; it never prescribes what a story should contain.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { CheckinChangedDocument } from './checkin-delta';

export const CHECKIN_TOOL_NAME = 'submit_project_checkin' as const;
export const CHECKIN_MAX_CARDS = 4;

/**
 * A card as stored and rendered; targets are already resolved to objects.
 * There is one kind: the title is the question the Agent wants to ask or the
 * work it wants to do, and opening the card hands `instruction` to a General
 * Agent session that chooses its own tools.
 */
export interface CheckinCard {
  id: string;
  title: string;
  /** Short evidence from the changes; may be empty. */
  detail: string;
  /** The self-contained task the General Agent receives when opened. */
  instruction: string;
  target: { entityType: CheckinChangedDocument['entityType']; entityId: string; title: string } | null;
}

/**
 * Every provider route receives this schema verbatim as a non-strict tool
 * (OpenAI and the ChatGPT subscription through Responses with `strict: false`,
 * Anthropic as `input_schema`, DeepSeek as Chat Completions `parameters`), so
 * it carries structure only. Limits such as the card count live in the
 * descriptions and are enforced while parsing: a model once returned the old
 * `maxItems: 4` beside `cards` as if it were an argument.
 */
export const checkinToolSchema = Type.Object(
  {
    cards: Type.Array(
      Type.Object(
        {
          title: Type.String({
            description:
              'The question itself, or the work you want to do, in at most 40 characters',
          }),
          detail: Type.Optional(
            Type.String({ description: 'One or two sentences of evidence from the changes' }),
          ),
          instruction: Type.String({
            description:
              'The self-contained task the General Agent receives when the author opens this card',
          }),
          target: Type.Optional(Type.String({ description: 'Ref of the changed object, such as c1' })),
        },
        { additionalProperties: false },
      ),
      {
        description: `Zero to ${CHECKIN_MAX_CARDS} cards, most useful first`,
      },
    ),
  },
  { additionalProperties: false },
);

export type CheckinToolOutput = Static<typeof checkinToolSchema>;

export const CHECKIN_TOOL_DESCRIPTION =
  'Submit the check-in cards for the author. Call exactly once.';

export const CHECKIN_SYSTEM_PROMPT = [
  'You prepare a short check-in for an author who is opening their writing project in Drifting. You see what changed in the manuscript and project objects since the previous check-in (or, when nothing changed, their most recent work), the project memory, the shared working memory and the open TODOs. You cannot edit the manuscript here.',
  'Purpose: help the author pick up the work quickly and keep the project records current. Return between zero and four cards, most useful first. Every card must rest on specific evidence in the changes provided; skip generic writing advice, praise, grading and restatements of what the author already knows. Zero cards is a good answer when nothing deserves attention.',
  'Each card is one thing you want to ask or do. Its title is the question itself, or the work you want to do. Opening the card starts a General Agent session with its instruction; that Agent has the full project tools and chooses for itself whether to ask the author, update records, add notes or TODOs, or combine them. Make the instruction self-contained: name the objects involved, give the evidence, and say what done looks like. Ask when only the author can resolve an uncertainty, open thread or decision; propose work when the project records need upkeep. Point a card at a changed object with its ref when one applies.',
  'Literary choices belong to the author. Do not push your own taste on style, plot or characters; serve the intentions recorded in project memory. Do not duplicate open TODOs or reopen matters project memory already settles. Changes made by the Agent or synced from another device may be drafts the author has not reviewed yet.',
  'Project Home separately offers the author a card that folds their newly written prose into elements, element changes and relations. Do not propose a card that only does that general upkeep; a card about one specific inconsistency or decision is still welcome.',
  'Memory upkeep is a card too; nothing changes until the author opens it. PROJECT_MEMORY.md holds the author\'s lasting thoughts, intentions, habits and standing instructions; story facts never belong there. WORKING_MEMORY.md holds recent shared work context. When working memory holds lasting author context that belongs in project memory, stale or finished detail, or project memory has duplicates, propose a single card that covers all of that upkeep. Its instruction identifies the passages and entries involved with short quotes and says what to move, merge or delete.',
  'Write titles, details and instructions in the language the author writes in.',
].join('\n\n');

export interface CheckinContextInput {
  projectName: string;
  nowIso: string;
  sinceIso: string;
  mode: 'changes' | 'resume';
  documents: readonly CheckinChangedDocument[];
  projectMemory: readonly { id: string; body: string }[];
  /** Null when the document is too large to include in a check-in. */
  workingMemory: string | null;
  openTodos: readonly string[];
  chapterTitles: readonly string[];
}

const OBJECT_KIND_LABELS: Record<CheckinChangedDocument['objectKind'], string> = {
  chapter: 'chapter',
  idea: 'idea',
  element: 'element',
  storyline: 'storyline',
  category: 'element category',
};

function sourceSummary(document: CheckinChangedDocument): string {
  const parts: string[] = [];
  if (document.revisions.user > 0) parts.push(`author ${document.revisions.user}`);
  if (document.revisions.agent > 0) parts.push(`Agent ${document.revisions.agent}`);
  if (document.revisions.remote > 0) parts.push(`other device ${document.revisions.remote}`);
  return parts.join(', ');
}

/** The single user message: bounded, deterministic, and free of internal ids. */
export function buildCheckinContext(input: CheckinContextInput): string {
  const sections: string[] = [
    `Project: ${input.projectName || '(untitled)'}`,
    `Now: ${input.nowIso}`,
    input.mode === 'changes'
      ? `Changes since the previous check-in at ${input.sinceIso}:`
      : `Nothing changed since the previous check-in. The author is returning after a break; these are their most recent changes since ${input.sinceIso}:`,
  ];
  if (input.documents.length === 0) {
    sections.push('(no prose changes)');
  }
  for (const document of input.documents) {
    sections.push(
      [
        `## ${document.ref} · ${OBJECT_KIND_LABELS[document.objectKind]} 「${document.title || 'untitled'}」`,
        `Last changed ${document.lastChangedAt}; revisions by ${sourceSummary(document)}.`,
        document.hasBaseline
          ? 'Changed passages (+ added, - removed, ~ revised with [-old-]{+new+}):'
          : 'New, or no earlier local version; current text excerpt:',
        document.digest,
      ].join('\n'),
    );
  }
  if (input.chapterTitles.length > 0) {
    sections.push(`Chapter order: ${input.chapterTitles.map((title) => `「${title}」`).join(' ')}`);
  }
  sections.push(
    input.openTodos.length > 0
      ? ['Open TODOs:', ...input.openTodos.map((todo) => `- ${todo}`)].join('\n')
      : 'Open TODOs: (none)',
  );
  sections.push(
    input.projectMemory.length > 0
      ? [
          'PROJECT_MEMORY.md:',
          ...input.projectMemory.map((entry) => `### memoryId ${entry.id}\n${entry.body}`),
        ].join('\n')
      : 'PROJECT_MEMORY.md: (empty)',
  );
  sections.push(
    input.workingMemory === null
      ? 'WORKING_MEMORY.md: (too large to include here; leave it to conversations)'
      : `WORKING_MEMORY.md:\n${input.workingMemory.trim() || '(empty)'}`,
  );
  return sections.join('\n\n');
}

export interface ParsedCheckin {
  cards: Omit<CheckinCard, 'id'>[];
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replaceAll('\u0000', '').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

/** `null` stands for an omitted field; no field of the schema accepts it. */
function withoutNullFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNullFields);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, withoutNullFields(field)]),
  );
}

/**
 * Validate the forced tool call. Fields the schema does not name and `null`
 * optional fields are dropped first: models add them around otherwise valid
 * results (`maxItems` beside `cards`, `"target": null`), and they carry
 * nothing to use; the memory fields earlier check-ins returned go the same
 * way. Unknown refs are dropped rather than trusted; a payload still invalid
 * after that is an error, never partial state.
 */
export function parseCheckinToolArguments(
  argumentsJson: string,
  documents: readonly CheckinChangedDocument[],
): ParsedCheckin {
  let raw: unknown;
  try {
    raw = JSON.parse(argumentsJson || '{}');
  } catch {
    throw new Error('The check-in returned malformed JSON.');
  }
  raw = Value.Clean(checkinToolSchema, withoutNullFields(raw));
  if (!Value.Check(checkinToolSchema, raw)) {
    const first = [...Value.Errors(checkinToolSchema, raw)][0];
    throw new Error(`The check-in result is invalid: ${first?.path ?? ''} ${first?.message ?? ''}`.trim());
  }
  const output = raw as CheckinToolOutput;
  const byRef = new Map(documents.map((document) => [document.ref, document]));
  const cards: ParsedCheckin['cards'] = [];
  for (const card of output.cards.slice(0, CHECKIN_MAX_CARDS)) {
    const title = text(card.title, 80);
    const detail = text(card.detail, 800);
    const instruction = text(card.instruction, 1_600);
    if (!title || !instruction) continue;
    const document = card.target ? byRef.get(card.target.trim()) : undefined;
    cards.push({
      title,
      detail,
      instruction,
      target: document
        ? { entityType: document.entityType, entityId: document.entityId, title: document.title }
        : null,
    });
  }
  return { cards };
}
