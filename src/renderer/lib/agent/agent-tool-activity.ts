import { uiTranslator as i18next } from '../locale-resources';

export interface AgentPermissionActionDescription {
  summary: string;
  details: readonly string[];
}

/** A streamed card is hidden until its arguments exist, so its domain label
 * never flickers through an invented placeholder target. */
export function shouldDisplayAgentToolActivity(input: {
  phase?: string;
  toolInput: unknown;
  status?: string;
}): boolean {
  return input.status === 'error' || input.phase !== 'arguments' || input.toolInput !== undefined;
}

/** Translate one explicit domain tool into the author-facing progress label. */
export function describeAgentToolActivity(
  toolName: string,
  input: unknown,
  language: string,
): string | null {
  const args = asRecord(input);
  const t = i18next.getFixedT(language);
  const target = firstString(args, [
    'chapter',
    'inspiration',
    'element',
    'storyline',
    'category',
    'entity',
    'material',
    'title',
    'name',
    'folder',
    'act',
    'item',
    'marker',
    'label',
    'relationId',
    'commentId',
    'ruleId',
    'patchId',
  ]);
  const quoted = target ? t('agentTools.permission.quote', { text: target }) : '';
  const query = stringValue(args.query);
  // A provider-hosted page read names its site, not the whole address.
  const site = toolName === 'web_open_page' ? siteOf(stringValue(args.url)) : '';

  const suffix = query && QUERY_LABELLED_TOOLS.has(toolName) ? '_query' : site ? '_site' : '';
  const key = `agentTools.activity.${toolName}${suffix}`;
  return i18next.exists(key, { lng: language }) ? t(key, { target: quoted, query, site }) : null;
}

/** Render validated arguments as a natural-language action first. Raw JSON is
 * retained by the caller only in the collapsed technical disclosure. */
export function describeAgentPermissionAction(
  toolName: string,
  input: unknown,
  language: string,
): AgentPermissionActionDescription | null {
  const args = asRecord(input);
  const t = i18next.getFixedT(language);
  const quote = (text: string) => text ? t('agentTools.permission.quote', { text }) : '';
  const label = (key: string, values: Record<string, string | number> = {}) => t(`agentTools.permission.${key}`, values);
  let summary: string | null = null;
  if (toolName === 'create_relation' && stringValue(args.fromName) && stringValue(args.toName)) {
    const typed = (kind: unknown, name: unknown) => {
      const key = `agentTools.kinds.${stringValue(kind)}`;
      return `${i18next.exists(key, { lng: language }) ? t(key) : stringValue(kind)}${quote(stringValue(name))}`;
    };
    summary = label('relationCreate', {
      source: typed(args.fromType, args.fromName), destination: typed(args.toType, args.toName),
      relationType: stringValue(args.relationType) || label('related'),
    });
  } else if (toolName === 'update_relation') {
    summary = label('relationUpdate', {
      target: quote(stringValue(args.relationId)),
      change: stringValue(args.relationType) ? label('relationType', { target: quote(stringValue(args.relationType)) }) : label('relationClear'),
    });
  }
  const membership: Record<string, string> = {
    add_chapter_to_storyline: 'membershipAdd', remove_chapter_from_storyline: 'membershipRemove',
    set_chapter_primary_storyline: 'membershipPrimary', replace_storyline_chapters: 'membershipReplace',
  };
  if (membership[toolName]) summary = label(membership[toolName], {
    chapter: quote(stringValue(args.chapter)), storyline: quote(stringValue(args.storyline)),
    count: Array.isArray(args.chapters) ? args.chapters.length : 0,
  });
  summary ??= describeAgentToolActivity(toolName, args, language);
  if (!summary) return null;
  const details: string[] = [];
  if (stringValue(args.body)) details.push(label('body', { text: compactText(stringValue(args.body), 180) }));
  if (stringValue(args.summary)) details.push(label('summary', { text: compactText(stringValue(args.summary), 140) }));
  const changes = Array.isArray(args.changes) ? args.changes : [];
  for (const value of changes.slice(0, 3)) {
    const change = asRecord(value);
    details.push(label('replace', {
      current: compactText(stringValue(change.currentText), 70),
      revised: compactText(typeof change.revisedText === 'string' ? change.revisedText : '', 70),
    }));
  }
  if (changes.length > 3) details.push(label('moreChanges', { count: changes.length - 3 }));
  if (Array.isArray(args.chapters)) {
    const chapters = args.chapters.filter((value): value is string => typeof value === 'string');
    details.push(label('chapters', { text: chapters.length ? chapters.join(label('listSeparator')) : label('clearMembers') }));
  }
  return { summary, details };
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

/** Tools whose label quotes the search they ran (project, manuscript, web). */
const QUERY_LABELLED_TOOLS: ReadonlySet<string> = new Set(['search_prose', 'search_project', 'web_search']);

function siteOf(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return '';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const candidate = stringValue(value[key]);
    if (candidate) return candidate;
  }
  return '';
}
