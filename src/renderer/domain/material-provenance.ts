import { parseKv, stringifyKv } from './kv';

/**
 * Where a material came from, stored as `library_item.provenance_json`.
 *
 * `null` means the author imported or linked the material themselves, which is
 * every material created before this field and every picker/URL/snippet import.
 * The shape is versioned by `v`; readers ignore versions they do not know.
 */
export type MaterialProvenance = GeneratedMaterialProvenance | FormerPortraitProvenance;

export interface GeneratedMaterialProvenance {
  v: 1;
  origin: 'generated';
  generation: MaterialGeneration;
}

/** The element's portrait until the author replaced it. */
export interface FormerPortraitProvenance {
  v: 1;
  origin: 'element-portrait';
  elementId: string;
  replacedAt: string;
}

export interface MaterialGeneration {
  provider: 'chatgpt-subscription';
  model: string;
  /** Exact prompt sent to the provider. */
  prompt: string;
  subjectPrompt: string | null;
  styleText: string | null;
  extraPrompt: string | null;
  target: { kind: 'element'; id: string } | null;
  generationId: string | null;
  conversationId: string | null;
  /** Materials an edit started from; empty for a fresh generation. */
  sourceItemIds: string[];
  generatedAt: string;
}

const MAX_PROVENANCE_JSON_CHARS = 32_000;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseGeneration(raw: unknown): MaterialGeneration | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.provider !== 'chatgpt-subscription') return null;
  if (typeof record.model !== 'string' || typeof record.prompt !== 'string') return null;
  if (typeof record.generatedAt !== 'string') return null;
  const target = record.target as Record<string, unknown> | null | undefined;
  return {
    provider: 'chatgpt-subscription',
    model: record.model,
    prompt: record.prompt,
    subjectPrompt: stringOrNull(record.subjectPrompt),
    styleText: stringOrNull(record.styleText),
    extraPrompt: stringOrNull(record.extraPrompt),
    target:
      target && target.kind === 'element' && typeof target.id === 'string'
        ? { kind: 'element', id: target.id }
        : null,
    generationId: stringOrNull(record.generationId),
    conversationId: stringOrNull(record.conversationId),
    sourceItemIds: Array.isArray(record.sourceItemIds)
      ? record.sourceItemIds.filter((id): id is string => typeof id === 'string')
      : [],
    generatedAt: record.generatedAt,
  };
}

/** Lenient read: malformed or future-version JSON reads as "unknown origin". */
export function parseMaterialProvenance(raw: string | null | undefined): MaterialProvenance | null {
  if (!raw || raw.length > MAX_PROVENANCE_JSON_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (record.origin === 'generated') {
    const generation = parseGeneration(record.generation);
    return generation ? { v: 1, origin: 'generated', generation } : null;
  }
  if (
    record.origin === 'element-portrait' &&
    typeof record.elementId === 'string' &&
    typeof record.replacedAt === 'string'
  ) {
    return {
      v: 1,
      origin: 'element-portrait',
      elementId: record.elementId,
      replacedAt: record.replacedAt,
    };
  }
  return null;
}

/** Strict check for a value about to be written. */
export function isValidMaterialProvenanceJson(raw: string | null): boolean {
  if (raw === null) return true;
  return raw.length <= MAX_PROVENANCE_JSON_CHARS && parseMaterialProvenance(raw) !== null;
}

export function serializeMaterialProvenance(provenance: MaterialProvenance): string {
  const json = JSON.stringify(provenance);
  if (json.length > MAX_PROVENANCE_JSON_CHARS) {
    throw new Error('Material provenance is too large');
  }
  return json;
}

export type MaterialSource = 'author' | 'generated' | 'former-portrait';

/** Coarse origin for listings; unknown or malformed provenance reads as the author's own. */
export function materialSource(raw: string | null | undefined): MaterialSource {
  const provenance = parseMaterialProvenance(raw);
  if (provenance?.origin === 'generated') return 'generated';
  if (provenance?.origin === 'element-portrait') return 'former-portrait';
  return 'author';
}

/** Project fact holding the art style every generated image follows. */
export const ART_STYLE_FACT_KEY = '美术风格';

export function readArtStyle(projectKvJson: string | null | undefined): string {
  const entry = parseKv(projectKvJson).find((row) => row.key.trim() === ART_STYLE_FACT_KEY);
  return entry?.value.trim() ?? '';
}

/** Updates the art style fact in place, appending it when the project has none. */
export function withArtStyle(projectKvJson: string | null | undefined, style: string): string {
  const rows = parseKv(projectKvJson);
  const value = style.trim();
  const index = rows.findIndex((row) => row.key.trim() === ART_STYLE_FACT_KEY);
  if (index >= 0) {
    rows[index] = { key: ART_STYLE_FACT_KEY, value };
  } else if (value) {
    rows.push({ key: ART_STYLE_FACT_KEY, value });
  }
  return stringifyKv(rows);
}

/** The prompt actually sent: the Agent's subject description plus the project style. */
export function composeImagePrompt(subjectPrompt: string, styleText: string | null): string {
  const subject = subjectPrompt.trim();
  const style = styleText?.trim();
  return style ? `${subject}\n\n画风：${style}` : subject;
}
