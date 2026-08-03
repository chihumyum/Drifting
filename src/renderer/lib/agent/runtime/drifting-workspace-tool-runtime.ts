import { Value } from '@sinclair/typebox/value';

import { isChapter } from '../../../domain/book-node';
import { parseKv, type KvEntry } from '../../../domain/kv';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import { countWords } from '../../word-count';
import {
  canonicalAgentRuntimeJson,
  type AgentRuntimePersistenceRepository,
} from '../../../sqlite-repo/agent-runtime-persistence-repo';
import { getActiveAgentToolContext, type AgentToolContext } from '../tool-handlers';
import { getRegisteredTool } from '../tool-registry';
import { isAgentAbort, throwIfAgentAborted } from './errors';
import { clonePortableData } from './portable-data';
import type {
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
  AgentToolRuntime,
} from './types';
import {
  applyWorkspaceTextReplacements,
  parseWorkspaceTextReplacements,
  type WorkspaceTextReplacement,
} from './workspace-prose-file';
import {
  DRIFTING_WORKSPACE_DELETE_TOOL,
  DRIFTING_WORKSPACE_EDIT_TOOL,
  DRIFTING_WORKSPACE_READ_TOOLS,
  DRIFTING_WORKSPACE_WRITE_TOOL,
  isDriftingWorkspaceCommandName,
  type DriftingWorkspaceCommandName,
  type DriftingWorkspaceReadToolName,
} from './drifting-workspace-tool-contract';

export {
  DRIFTING_WORKSPACE_DELETE_TOOL,
  DRIFTING_WORKSPACE_EDIT_TOOL,
  DRIFTING_WORKSPACE_READ_TOOLS,
  DRIFTING_WORKSPACE_WRITE_TOOL,
} from './drifting-workspace-tool-contract';

type WorkspaceTarget =
  | { kind: 'overview' }
  | { kind: 'project_facts' }
  | {
      kind: 'node_prose' | 'node_summary' | 'node_title' | 'node_meta';
      nodeId: string;
      nodeName: string;
      nodeKind: 'chapter' | 'drift';
    }
  | {
      kind:
        | 'element_body'
        | 'element_summary'
        | 'element_name'
        | 'element_aliases'
        | 'element_facts'
        | 'element_group'
        | 'element_category'
        | 'element_meta';
      elementId: string;
      elementName: string;
    }
  | {
      kind:
        | 'storyline_body'
        | 'storyline_summary'
        | 'storyline_name'
        | 'storyline_facts'
        | 'storyline_chapters'
        | 'storyline_meta';
      storylineId: string;
      storylineName: string;
    }
  | {
      kind: 'category_body' | 'category_meta';
      categoryId: string;
      categoryName: string;
    }
  | { kind: 'material'; materialId: string; materialTitle: string }
  | { kind: 'comments' }
  | { kind: 'comment'; commentId: string }
  | {
      kind: 'relation';
      relationId: string;
      fromKind: string;
      fromId: string;
    }
  | { kind: 'memory_collection' }
  | { kind: 'memory'; memoryId: string };

interface WorkspaceEntry {
  path: string;
  writable: boolean;
  description: string;
  target: WorkspaceTarget;
}

interface ReadFreshnessObservation {
  id: string;
  entityKind: string;
  entityId: string;
  revision: string;
}

interface ReadFreshness {
  receiptId: string;
  observations: ReadFreshnessObservation[];
}

interface CanonicalReadResult {
  value: unknown;
  freshness: ReadFreshness | null;
}

interface CompactProseBlock {
  block: number;
  displayText: string;
  typePrefix: string;
  rawText: string;
}

interface WorkspaceCommand {
  name: DriftingWorkspaceCommandName;
  arguments: Record<string, unknown>;
}

interface WorkspaceReadCoverage {
  fingerprint: string;
  totalChars: number;
  ranges: Array<{ start: number; end: number }>;
}

const DEFAULT_READ_LIMIT = 16_000;
const MAX_LISTED_FILES = 500;
const MAX_TRACKED_READ_COVERAGE = 512;
const WORKSPACE_COMMAND_ARGUMENT = '__workspaceCommand';

interface WorkspaceListItem {
  path: string;
  name: string;
  type: 'directory' | 'file';
  writable: boolean;
  description: string;
  descendants?: WorkspaceEntry[];
}

export interface DriftingWorkspaceToolRuntimeOptions {
  readRuntime: AgentToolRuntime;
  getContext?: () => AgentToolContext | null;
  persistence?: AgentRuntimePersistenceRepository;
  now?: () => string;
}

/**
 * Small provider-facing filesystem illusion over Drifting's structured model.
 *
 * The paths are not host paths. Reads still flow through certified Drifting
 * reads (and therefore live Yjs); writes are prepared into one hidden domain
 * command with a runtime-owned freshness citation before the durable write
 * coordinator sees them.
 */
export class DriftingWorkspaceToolRuntime implements AgentToolRuntime {
  private readonly readRuntime: AgentToolRuntime;
  private readonly getContext: () => AgentToolContext | null;
  private readonly persistence: AgentRuntimePersistenceRepository | undefined;
  private readonly now: () => string;
  private readonly readCoverage = new Map<string, WorkspaceReadCoverage>();

  constructor(options: DriftingWorkspaceToolRuntimeOptions) {
    this.readRuntime = options.readRuntime;
    this.getContext = options.getContext ?? getActiveAgentToolContext;
    this.persistence = options.persistence;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  listDefinitions(context: AgentRuntimeContext): readonly AgentToolDefinition[] {
    this.requireProject(context);
    return DRIFTING_WORKSPACE_READ_TOOLS.map((name) => workspaceDefinition(name));
  }

  async execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult> {
    throwIfAgentAborted(request.signal);
    if (request.access !== 'read') {
      return {
        ok: false,
        error: `Workspace read runtime denied write tool "${request.name}"`,
      };
    }
    if (!DRIFTING_WORKSPACE_READ_TOOLS.includes(request.name as DriftingWorkspaceReadToolName)) {
      return { ok: false, error: `Unknown workspace read tool "${request.name}"` };
    }

    try {
      const projectId = this.requireProject(request.context);
      if (request.name === 'list_files') {
        const data = await this.listFiles(projectId, request.arguments.path, request);
        return { ok: true, data, modelData: workspaceReadModelData(data) };
      }
      if (request.name === 'read_file') {
        const data = await this.readFile(projectId, request);
        return { ok: true, data, modelData: workspaceReadModelData(data) };
      }
      const data = await this.grep(projectId, request);
      return { ok: true, data, modelData: workspaceReadModelData(data) };
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Workspace operation failed',
      };
    }
  }

  /** Convert a public workspace mutation into one certified hidden command. */
  async prepareWriteRequest(
    request: AgentToolExecutionRequest,
  ): Promise<AgentToolExecutionRequest> {
    if (
      request.name !== DRIFTING_WORKSPACE_EDIT_TOOL &&
      request.name !== DRIFTING_WORKSPACE_WRITE_TOOL &&
      request.name !== DRIFTING_WORKSPACE_DELETE_TOOL
    ) {
      return request;
    }
    throwIfAgentAborted(request.signal);
    const projectId = this.requireProject(request.context);
    if (request.name === DRIFTING_WORKSPACE_WRITE_TOOL) {
      const path = normalizeWorkspaceWritePath(request.arguments.path);
      const content = String(request.arguments.content ?? '');
      const resolvedPath = resolveWorkspacePath(projectId, path);
      const existing =
        findWorkspaceEntry(projectId, resolvedPath) ??
        (await this.resolveDynamicMemoryEntry(projectId, resolvedPath, request));
      const prepared = existing
        ? await this.prepareWholeFileCommand(existing, content, request)
        : await this.prepareCreateCommand(path, content, request);
      if (existing) this.invalidateReadCoverage(request, existing.path);
      return {
        ...request,
        arguments: {
          path,
          content,
          expectedRevision: prepared.expectedRevision,
          [WORKSPACE_COMMAND_ARGUMENT]: prepared.command,
        },
      };
    }
    if (request.name === DRIFTING_WORKSPACE_DELETE_TOOL) {
      const path = resolveWorkspacePath(projectId, request.arguments.path);
      const prepared = await this.prepareDeleteCommand(path, request);
      return {
        ...request,
        arguments: {
          path,
          expectedRevision: prepared.expectedRevision,
          [WORKSPACE_COMMAND_ARGUMENT]: prepared.command,
        },
      };
    }
    const entry = requireWorkspaceFileEntry(projectId, request.arguments.path, true);
    const path = entry.path;
    if (!entry.writable) {
      throw new Error(`"${path}" is read-only in this version of the workspace`);
    }
    const replacements = parseWorkspaceTextReplacements(request.arguments.replacements);
    const prepared = await this.prepareWorkspaceCommand(entry, replacements, request);
    this.invalidateReadCoverage(request, path);
    return {
      ...request,
      arguments: {
        path,
        replacements: request.arguments.replacements,
        expectedRevision: prepared.expectedRevision,
        [WORKSPACE_COMMAND_ARGUMENT]: prepared.command,
      },
    };
  }

  /** @deprecated compatibility for older product composition/tests. */
  async prepareEditRequest(request: AgentToolExecutionRequest): Promise<AgentToolExecutionRequest> {
    return this.prepareWriteRequest(request);
  }

  private async listFiles(
    projectId: string,
    rawPrefix: unknown,
    request: AgentToolExecutionRequest,
  ) {
    const prefix = resolveWorkspacePath(projectId, rawPrefix ?? '/');
    if (prefix === '/memory') {
      const read = await this.canonicalRead(request, 'list_memory', {}, 'memory-directory');
      const memories = recordArray(read.value, 'memories');
      return {
        path: prefix,
        files: memories.map((memory) => {
          const memoryId = String(memory.memoryId ?? '');
          return {
            path: `/memory/${pathSegment(memoryId)}.json`,
            name: String(memory.body ?? '').slice(0, 80) || '写作指南',
            type: 'file' as const,
            writable: memory.source === 'agent' && memory.status === 'pending',
            description: `${String(memory.kind ?? 'preference')} · ${String(memory.status ?? 'pending')}`,
          };
        }),
        total: memories.length,
        truncated: false,
      };
    }
    const entries = buildWorkspaceEntries(projectId).filter((entry) =>
      pathIsWithin(entry.path, prefix),
    );
    if (entries.length === 0 && isEmptyElementCategoryDirectory(projectId, prefix)) {
      return {
        path: prefix,
        files: [],
        total: 0,
        truncated: false,
        creationGuide: workspaceDirectoryCreationGuide(prefix),
      };
    }
    if (entries.length === 0 && isVirtualWorkspaceRoot(prefix) && prefix !== '/elements') {
      return {
        path: prefix,
        files: [],
        total: 0,
        truncated: false,
        creationGuide: workspaceDirectoryCreationGuide(prefix),
      };
    }
    if (entries.length === 0 && prefix !== '/elements') {
      throw new Error(`No virtual directory exists at "${prefix}"`);
    }

    const children = new Map<string, WorkspaceListItem>();
    for (const entry of entries) {
      if (entry.path === prefix) {
        children.set(entry.path, {
          path: entry.path,
          name: workspaceEntryDisplayName(entry),
          type: 'file',
          writable: entry.writable,
          description: entry.description,
        });
        continue;
      }

      const relative = entry.path.slice(prefix === '/' ? 1 : prefix.length + 1);
      const [firstSegment, ...rest] = relative.split('/');
      const childPath = prefix === '/' ? `/${firstSegment}` : `${prefix}/${firstSegment}`;
      if (rest.length === 0) {
        children.set(childPath, {
          path: entry.path,
          name: workspaceEntryDisplayName(entry),
          type: 'file',
          writable: entry.writable,
          description: entry.description,
        });
        continue;
      }

      const existing = children.get(childPath);
      if (existing?.type === 'directory') {
        existing.writable ||= entry.writable;
        existing.descendants?.push(entry);
      } else {
        children.set(childPath, {
          path: childPath,
          name: '',
          type: 'directory',
          writable: entry.writable,
          description: '',
          descendants: [entry],
        });
      }
    }

    if (prefix === '/elements') {
      for (const category of useDataStore
        .getState()
        .bookElementCategories.filter((item) => item.projectId === projectId)) {
        const childPath = `/elements/${pathSegment(category.name)}`;
        if (children.has(childPath)) continue;
        children.set(childPath, {
          path: childPath,
          name: category.name,
          type: 'directory',
          writable: true,
          description:
            `Empty element category. Create an element by writing ` +
            `${childPath}/<element-name>/body.md directly.`,
          descendants: [],
        });
      }
    }

    const items = [...children.values()]
      .map((item) =>
        item.type === 'directory'
          ? {
              ...item,
              name: workspaceDirectoryDisplayName(item.path, item.descendants ?? []),
              description:
                item.description ||
                describeWorkspaceDirectory(projectId, item.path, item.descendants ?? []),
            }
          : item,
      )
      .sort((left, right) => compareWorkspaceListItems(projectId, prefix, left, right));
    return {
      path: prefix,
      files: items
        .slice(0, MAX_LISTED_FILES)
        .map(({ path, name, type, writable, description }) => ({
          path,
          name,
          type,
          writable,
          description,
        })),
      total: items.length,
      truncated: items.length > MAX_LISTED_FILES,
      creationGuide: workspaceDirectoryCreationGuide(prefix),
    };
  }

  private async readFile(projectId: string, request: AgentToolExecutionRequest) {
    const resolved = resolveWorkspacePath(projectId, request.arguments.path);
    const entry =
      findWorkspaceEntry(projectId, resolved) ??
      (await this.resolveDynamicMemoryEntry(projectId, resolved, request)) ??
      primaryWorkspaceEntry(projectId, resolved);
    if (!entry) return this.listFiles(projectId, resolved, request);
    const path = entry.path;
    const content = await this.renderEntry(entry, request);
    const offset = boundedInteger(request.arguments.offset, 0, 0, content.length);
    const limit = boundedInteger(request.arguments.limit, DEFAULT_READ_LIMIT, 1, 32_000);
    const page = sliceCodePoints(content, offset, limit);
    const nextOffset = Math.min(codePointLength(content), offset + codePointLength(page));
    const totalChars = codePointLength(content);
    await this.recordReadCoverage(request, path, content, offset, nextOffset, totalChars);
    // A node's stored wordCount is only a projection and old imported drafts
    // can legitimately have an empty Yjs truth plus a stale non-zero counter.
    // Once this call has paid to read the live body, report the live count so
    // the model never sees contradictory "1057 words + empty file" evidence.
    const wordCount = entry.target.kind === 'node_prose' ? countWords(content) : null;
    return {
      path,
      name: workspaceEntryDisplayName(entry),
      content: page,
      writable: entry.writable,
      offset,
      nextOffset,
      totalChars,
      truncated: nextOffset < totalChars,
      ...(wordCount !== null ? { wordCount } : {}),
    };
  }

  private async grep(projectId: string, request: AgentToolExecutionRequest) {
    const query = String(request.arguments.query ?? '').trim();
    if (!query) throw new Error('grep requires a non-empty query');
    const prefix = resolveWorkspacePath(projectId, request.arguments.path ?? '/');
    const limit = boundedInteger(request.arguments.limit, 30, 1, 100);
    const entries = buildWorkspaceEntries(projectId);
    if (!workspacePathExists(projectId, entries, prefix)) {
      throw new Error(`No virtual file or directory exists at "${prefix}"`);
    }
    const literalEntry =
      entries.find((entry) => entry.path === prefix) ??
      (isVirtualWorkspaceRoot(prefix) ? undefined : primaryWorkspaceEntry(projectId, prefix));
    if (literalEntry) {
      const content = await this.renderEntry(literalEntry, request);
      const occurrences = literalWorkspaceMatches(literalEntry, content, query);
      return {
        query,
        path: literalEntry.path,
        matches: occurrences.slice(0, limit),
        total: occurrences.length,
        exact: true,
        truncated: occurrences.length > limit,
        ranking: 'literal-file-v1',
      };
    }

    if (prefix === '/relations') {
      const state = useDataStore.getState();
      const occurrences = entries.flatMap((entry) => {
        const target = entry.target;
        if (target.kind !== 'relation') return [];
        const relation = state.entityRelations.find(
          (candidate) =>
            candidate.id === target.relationId && candidate.projectId === projectId,
        );
        if (!relation) return [];
        return literalWorkspaceMatches(
          entry,
          prettyJson({
            fromKind: relation.fromKind,
            from: entityDisplayName(state, relation.fromKind, relation.fromId),
            toKind: relation.toKind,
            to: entityDisplayName(state, relation.toKind, relation.toId),
            kind: relation.kind,
          }),
          query,
        );
      });
      return {
        query,
        path: prefix,
        matches: occurrences.slice(0, limit),
        total: occurrences.length,
        exact: true,
        truncated: occurrences.length > limit,
        ranking: 'literal-relation-v1',
      };
    }

    const byEntity = new Map<string, WorkspaceEntry[]>();
    for (const entry of entries) {
      const key = workspaceEntityKey(entry.target);
      if (!key) continue;
      const candidates = byEntity.get(key) ?? [];
      candidates.push(entry);
      byEntity.set(key, candidates);
    }

    const [metadataRead, proseRead] = await Promise.all([
      this.canonicalRead(request, 'search_project', { query }, 'grep-meta'),
      this.canonicalRead(request, 'search_prose', { query, limit }, 'grep-prose'),
    ]);
    const matches: Array<{
      path: string;
      name: string;
      line?: number;
      snippet: string;
      score: number;
      matchedTerms: string[];
      freshness: unknown;
    }> = [];
    const seen = new Set<string>();
    for (const match of recordArray(metadataRead.value, 'matches')) {
      const kind = String(match.kind ?? '');
      const title = String(match.label ?? '');
      const snippet = String(match.snippet ?? title);
      if (!containsLiteralQuery(`${title}\n${snippet}`, query)) continue;
      const entry = workspaceSearchEntryForField(
        byEntity.get(`${normalizeEntityKind(kind)}:${title}`) ?? [],
        String(match.matchedIn ?? ''),
      );
      if (!entry || !pathIsWithin(entry.path, prefix)) continue;
      const key = `${entry.path}:${snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        path: entry.path,
        name: workspaceEntryDisplayName(entry),
        snippet,
        score: Number(match.score ?? 0),
        matchedTerms: Array.isArray(match.matchedTerms)
          ? match.matchedTerms.filter((term): term is string => typeof term === 'string')
          : [],
        freshness: match.freshness ?? null,
      });
    }
    for (const match of recordArray(proseRead.value, 'matches')) {
      const kind = String(match.kind ?? '');
      const title = String(match.title ?? '');
      const snippet = String(match.snippet ?? '');
      if (!containsLiteralQuery(`${title}\n${snippet}`, query)) continue;
      const entry = workspaceSearchEntryForField(
        byEntity.get(`${normalizeEntityKind(kind)}:${title}`) ?? [],
        'prose',
      );
      if (!entry || !pathIsWithin(entry.path, prefix)) continue;
      const line = positiveInteger(match.block);
      const key = `${entry.path}:${line ?? ''}:${snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        path: entry.path,
        name: workspaceEntryDisplayName(entry),
        ...(line ? { line } : {}),
        snippet,
        score: Number(match.score ?? 0),
        matchedTerms: Array.isArray(match.matchedTerms)
          ? match.matchedTerms.filter((term): term is string => typeof term === 'string')
          : [],
        freshness: match.freshness ?? null,
      });
    }
    matches.sort(
      (left, right) =>
        right.score - left.score ||
        right.matchedTerms.length - left.matchedTerms.length ||
        left.path.localeCompare(right.path, 'en') ||
        (left.line ?? 0) - (right.line ?? 0),
    );
    return {
      query,
      path: prefix,
      matches: matches.slice(0, limit),
      total: matches.length,
      exact: false,
      truncated: matches.length > limit || recordBoolean(proseRead.value, 'truncated'),
      ranking: 'drifting-evidence-v1',
    };
  }

  private async resolveDynamicMemoryEntry(
    projectId: string,
    path: string,
    request: AgentToolExecutionRequest,
  ): Promise<WorkspaceEntry | null> {
    if (request.context.route.projectId !== projectId) return null;
    const match = /^\/memory\/([^/]+)\.json$/u.exec(path);
    if (!match) return null;
    const memoryId = decodePathSegment(match[1] ?? '');
    if (!memoryId) return null;
    const read = await this.canonicalRead(request, 'list_memory', {}, 'memory-entry');
    const memory = recordArray(read.value, 'memories').find(
      (candidate) => String(candidate.memoryId ?? '') === memoryId,
    );
    if (!memory) return null;
    return {
      path: `/memory/${pathSegment(memoryId)}.json`,
      writable: memory.source === 'agent' && memory.status === 'pending',
      description: `${String(memory.kind ?? 'preference')} · ${String(memory.status ?? 'pending')}`,
      target: { kind: 'memory', memoryId },
    };
  }

  private async renderEntry(
    entry: WorkspaceEntry,
    request: AgentToolExecutionRequest,
  ): Promise<string> {
    const target = entry.target;
    if (target.kind === 'overview') {
      const read = await this.canonicalRead(request, 'get_overview', {}, 'overview');
      return renderOverview(
        read.value,
        buildWorkspaceEntries(this.requireProject(request.context)),
      );
    }
    if (target.kind === 'comments') {
      const read = await this.canonicalRead(request, 'list_comments', {}, 'comments');
      return renderComments(read.value);
    }
    if (target.kind === 'comment') {
      const read = await this.canonicalRead(request, 'list_comments', {}, 'comment');
      const comment = recordArray(read.value, 'comments').find(
        (candidate) => String(candidate.id ?? '') === target.commentId,
      );
      if (!comment) throw new Error('The comment moved or was deleted');
      return prettyJson(comment);
    }
    if (target.kind === 'relation') {
      const state = useDataStore.getState();
      const relation = state.entityRelations.find(
        (candidate) =>
          candidate.id === target.relationId &&
          candidate.projectId === this.requireProject(request.context),
      );
      if (!relation) throw new Error('The relation moved or was deleted');
      const read = await this.canonicalRead(
        request,
        'get_entity_relations',
        {
          kind: target.fromKind,
          name: entityReadReference(state, target.fromKind, target.fromId),
        },
        'relation',
      );
      void read;
      return prettyJson({
        fromKind: relation.fromKind,
        from: entityDisplayName(state, relation.fromKind, relation.fromId),
        toKind: relation.toKind,
        to: entityDisplayName(state, relation.toKind, relation.toId),
        kind: relation.kind,
      });
    }
    if (target.kind === 'memory_collection') {
      const read = await this.canonicalRead(request, 'list_memory', {}, 'memory');
      return renderMemories(read.value);
    }
    if (target.kind === 'memory') {
      const read = await this.canonicalRead(request, 'list_memory', {}, 'memory-item');
      const memory = recordArray(read.value, 'memories').find(
        (candidate) => String(candidate.memoryId ?? '') === target.memoryId,
      );
      if (!memory) throw new Error('The writing guidance moved or was deleted');
      return renderMemoryFile(memory);
    }
    if (target.kind === 'material') {
      const read = await this.canonicalRead(
        request,
        'read_material',
        { material: target.materialId },
        'material',
      );
      const value = asRecord(read.value);
      return typeof value.body === 'string' ? value.body : prettyJson(read.value);
    }
    if (target.kind === 'project_facts') {
      const read = await this.canonicalRead(request, 'get_project_brief', {}, 'project-facts');
      return prettyJson(asRecord(read.value).facts ?? []);
    }
    if (isNodeTarget(target)) {
      const prose = target.kind === 'node_prose';
      const read = await this.canonicalRead(
        request,
        'read_node',
        { node: target.nodeId, prose },
        prose ? 'node-prose' : 'node-header',
      );
      if (target.kind === 'node_prose') {
        return compactProseBlocks(read.value)
          .map((block) => block.displayText)
          .join('\n\n');
      }
      const node = currentNode(target.nodeId, this.requireProject(request.context));
      if (target.kind === 'node_title') return node.title;
      if (target.kind === 'node_summary') return node.summary;
      return prettyJson({
        title: node.title,
        kind: node.kind,
        status: node.writingStatus,
        words: node.wordCount,
        narrativeOrder: node.narrativeOrder,
        ...(isChapter(node) ? { bookOrder: node.bookOrder } : {}),
      });
    }
    if (isElementTarget(target)) {
      if (target.kind === 'element_body') {
        // Use the same numbered live-Yjs projection as whole-file preparation.
        // read_element.body intentionally flattens rich block types to plain
        // text, so fingerprinting that representation made a complete
        // read_file look incomplete when headings or trailing block spacing
        // were present.
        const read = await this.canonicalRead(
          request,
          'read_node',
          { node: target.elementId, kind: 'element', prose: true },
          'element-body',
        );
        return compactProseBlocks(read.value)
          .map((block) => block.displayText)
          .join('\n\n');
      }
      const read = await this.canonicalRead(
        request,
        'read_element',
        { element: target.elementId },
        'element',
      );
      const value = asRecord(read.value);
      switch (target.kind) {
        case 'element_summary':
          return String(value.summary ?? '');
        case 'element_name':
          return String(value.name ?? '');
        case 'element_aliases':
          return prettyJson(value.aliases ?? []);
        case 'element_facts':
          return prettyJson(value.facts ?? []);
        case 'element_group':
          return String(value.groupName ?? '');
        case 'element_category':
          return String(value.category ?? '');
        default:
          return prettyJson(value);
      }
    }
    if (isStorylineTarget(target)) {
      if (target.kind === 'storyline_body') {
        const read = await this.canonicalRead(
          request,
          'read_node',
          { node: target.storylineId, kind: 'storyline', prose: true },
          'storyline-body',
        );
        return compactProseBlocks(read.value)
          .map((block) => block.displayText)
          .join('\n\n');
      }
      const read = await this.canonicalRead(
        request,
        'get_storyline',
        { storyline: target.storylineId },
        'storyline',
      );
      const value = asRecord(read.value);
      switch (target.kind) {
        case 'storyline_summary':
          return String(value.summary ?? '');
        case 'storyline_name':
          return String(value.name ?? '');
        case 'storyline_facts':
          return prettyJson(value.facts ?? []);
        case 'storyline_chapters':
          return prettyJson(value.chapters ?? []);
        default:
          return prettyJson(value);
      }
    }
    const read = await this.canonicalRead(
      request,
      'read_node',
      { node: target.categoryId, kind: 'category', prose: true },
      'category',
    );
    if (target.kind === 'category_body') {
      return compactProseBlocks(read.value)
        .map((block) => block.displayText)
        .join('\n\n');
    }
    const category = useDataStore
      .getState()
      .bookElementCategories.find(
        (candidate) =>
          candidate.id === target.categoryId &&
          candidate.projectId === this.requireProject(request.context),
      );
    if (!category) throw new Error('The category moved or was deleted');
    return prettyJson({
      name: category.name,
      templateFacts: parseKv(category.elementTemplateKvJson),
    });
  }

  private async prepareWorkspaceCommand(
    entry: WorkspaceEntry,
    replacements: WorkspaceTextReplacement[],
    request: AgentToolExecutionRequest,
  ): Promise<{ expectedRevision: Record<string, string>; command: WorkspaceCommand }> {
    if (!entry.writable) {
      throw new Error(`"${entry.path}" is read-only in this version of the workspace`);
    }
    const target = entry.target;
    const proseTarget = workspaceProseTarget(target);
    if (proseTarget) {
      const read = await this.canonicalRead(
        request,
        'read_node',
        {
          node: proseTarget.id,
          kind: proseTarget.entityType === 'node' ? proseTarget.nodeKind : proseTarget.entityType,
          prose: true,
        },
        'edit-source',
      );
      const blocks = compactProseBlocks(read.value);
      applyWorkspaceTextReplacements(
        blocks.map((block) => block.displayText).join('\n\n'),
        replacements,
      );
      const expectedRevision = expectedRevisionFrom(
        read,
        `${proseTarget.entityType}_prose`,
        proseTarget.id,
      );
      return {
        expectedRevision,
        command: {
          name: 'edit_prose_file',
          arguments: {
            entity: proseTarget.id,
            kind: proseTarget.entityType === 'node' ? proseTarget.nodeKind : proseTarget.entityType,
            replacements,
            expectedRevision,
          },
        },
      };
    }
    if (target.kind === 'comment') {
      const read = await this.canonicalRead(request, 'list_comments', {}, 'edit-comment');
      const comment = recordArray(read.value, 'comments').find(
        (candidate) => String(candidate.id ?? '') === target.commentId,
      );
      if (!comment) throw new Error('The comment moved or was deleted');
      const next = parseJsonObjectFile(
        applyWorkspaceTextReplacements(prettyJson(comment), replacements),
        entry.path,
      );
      const expectedRevision = expectedRevisionFrom(read, 'comment', target.commentId);
      return {
        expectedRevision,
        command: {
          name: 'update_comment',
          arguments: {
            commentId: target.commentId,
            ...next,
            expectedRevision,
          },
        },
      };
    }
    if (target.kind === 'relation') {
      const current = await this.renderEntry(entry, request);
      const next = applyWorkspaceTextReplacements(current, replacements);
      return this.prepareWholeFileCommand(entry, next, request);
    }
    if (target.kind === 'node_summary' || target.kind === 'node_title') {
      const read = await this.canonicalRead(
        request,
        'read_node',
        { node: target.nodeId, prose: false },
        'edit-source',
      );
      const expectedRevision = expectedRevisionFrom(read, 'node', target.nodeId);
      const current = currentNode(target.nodeId, this.requireProject(request.context));
      const next = applyWorkspaceTextReplacements(
        target.kind === 'node_summary' ? current.summary : current.title,
        replacements,
      );
      return {
        expectedRevision,
        command:
          target.kind === 'node_summary'
            ? {
                name: 'set_node_summary',
                arguments: { node: target.nodeId, summary: next, expectedRevision },
              }
            : {
                name: 'rename_node',
                arguments: { node: target.nodeId, title: next, expectedRevision },
              },
      };
    }
    if (target.kind === 'project_facts') {
      const read = await this.canonicalRead(request, 'get_project_brief', {}, 'edit-source');
      const expectedRevision = expectedRevisionFrom(
        read,
        'project',
        this.requireProject(request.context),
      );
      const current = kvList(asRecord(read.value).facts);
      const next = parseKvFile(applyWorkspaceTextReplacements(prettyJson(current), replacements));
      const currentByKey = new Map(current.map((row) => [row.key, row.value]));
      for (const row of current) {
        if (!next.some((candidate) => candidate.key === row.key)) {
          throw new Error(
            'Deleting project fact keys is not yet supported by edit_file; change the value instead',
          );
        }
      }
      const changed = next.filter((row) => currentByKey.get(row.key) !== row.value);
      if (changed.length === 0) throw new Error('The replacements do not change the file');
      return {
        expectedRevision,
        command: {
          name: 'update_project_facts',
          arguments: { facts: changed, expectedRevision },
        },
      };
    }
    if (isElementTarget(target)) {
      const read = await this.canonicalRead(
        request,
        'read_element',
        { element: target.elementId },
        'edit-source',
      );
      const expectedRevision = expectedRevisionFrom(read, 'element', target.elementId);
      const value = asRecord(read.value);
      const update: Record<string, unknown> = {
        element: target.elementId,
        expectedRevision,
      };
      switch (target.kind) {
        case 'element_summary':
          update.summary = applyWorkspaceTextReplacements(
            String(value.summary ?? ''),
            replacements,
          );
          break;
        case 'element_name':
          update.name = applyWorkspaceTextReplacements(String(value.name ?? ''), replacements);
          break;
        case 'element_aliases':
          update.aliases = parseStringArrayFile(
            applyWorkspaceTextReplacements(prettyJson(value.aliases ?? []), replacements),
          );
          break;
        case 'element_facts':
          update.facts = parseKvFile(
            applyWorkspaceTextReplacements(prettyJson(value.facts ?? []), replacements),
          );
          break;
        case 'element_group':
          update.groupName = applyWorkspaceTextReplacements(
            String(value.groupName ?? ''),
            replacements,
          );
          break;
        case 'element_category':
          update.category = applyWorkspaceTextReplacements(
            String(value.category ?? ''),
            replacements,
          );
          break;
        default:
          throw new Error(`"${entry.path}" is read-only in this version of the workspace`);
      }
      return {
        expectedRevision,
        command: { name: 'update_element', arguments: update },
      };
    }
    if (isStorylineTarget(target)) {
      const read = await this.canonicalRead(
        request,
        'get_storyline',
        { storyline: target.storylineId },
        'edit-source',
      );
      const expectedRevision = expectedRevisionFrom(
        read,
        target.kind === 'storyline_chapters' ? 'storyline_membership' : 'storyline',
        target.storylineId,
      );
      const value = asRecord(read.value);
      const update: Record<string, unknown> = {
        storyline: target.storylineId,
        expectedRevision,
      };
      switch (target.kind) {
        case 'storyline_summary':
          update.summary = applyWorkspaceTextReplacements(
            String(value.summary ?? ''),
            replacements,
          );
          break;
        case 'storyline_name':
          update.name = applyWorkspaceTextReplacements(String(value.name ?? ''), replacements);
          break;
        case 'storyline_facts': {
          const current = kvList(value.facts);
          const next = parseKvFile(
            applyWorkspaceTextReplacements(prettyJson(current), replacements),
          );
          for (const row of current) {
            if (!next.some((candidate) => candidate.key === row.key)) {
              throw new Error(
                'Deleting storyline fact keys is not yet supported by edit_file; change the value instead',
              );
            }
          }
          const currentByKey = new Map(current.map((row) => [row.key, row.value]));
          update.facts = next.filter((row) => currentByKey.get(row.key) !== row.value);
          break;
        }
        case 'storyline_chapters': {
          const chapters = parseJsonArrayFile(
            applyWorkspaceTextReplacements(prettyJson(value.chapters ?? []), replacements),
            entry.path,
          );
          return {
            expectedRevision,
            command: {
              name: 'set_storyline_membership',
              arguments: {
                storyline: target.storylineId,
                chapters,
                expectedRevision,
              },
            },
          };
        }
        default:
          throw new Error(`"${entry.path}" is read-only in this version of the workspace`);
      }
      return {
        expectedRevision,
        command: { name: 'update_storyline', arguments: update },
      };
    }
    throw new Error(`"${entry.path}" is read-only in this version of the workspace`);
  }

  private async prepareWholeFileCommand(
    entry: WorkspaceEntry,
    content: string,
    request: AgentToolExecutionRequest,
  ): Promise<{ expectedRevision: Record<string, string>; command: WorkspaceCommand }> {
    if (!entry.writable) {
      throw new Error(`"${entry.path}" is read-only in this version of the workspace`);
    }
    const target = entry.target;
    const proseTarget = workspaceProseTarget(target);
    if (proseTarget) {
      const read = await this.canonicalRead(
        request,
        'read_node',
        {
          node: proseTarget.id,
          kind: proseTarget.entityType === 'node' ? proseTarget.nodeKind : proseTarget.entityType,
          prose: true,
        },
        'write-prose',
      );
      const current = compactProseBlocks(read.value)
        .map((block) => block.displayText)
        .join('\n\n');
      if (current === content) {
        throw new Error(`"${entry.path}" already has the requested contents`);
      }
      await this.requireCompleteWholeFileRead(entry.path, current, request);
      const expectedRevision = expectedRevisionFrom(
        read,
        `${proseTarget.entityType}_prose`,
        proseTarget.id,
      );
      return {
        expectedRevision,
        command: {
          name: 'edit_prose_file',
          arguments: {
            entity: proseTarget.id,
            kind: proseTarget.entityType === 'node' ? proseTarget.nodeKind : proseTarget.entityType,
            content,
            expectedRevision,
          },
        },
      };
    }
    if (target.kind === 'comment') {
      const read = await this.canonicalRead(request, 'list_comments', {}, 'write-comment');
      const expectedRevision = expectedRevisionFrom(read, 'comment', target.commentId);
      return {
        expectedRevision,
        command: {
          name: 'update_comment',
          arguments: {
            commentId: target.commentId,
            ...parseJsonObjectFile(content, entry.path),
            expectedRevision,
          },
        },
      };
    }
    if (target.kind === 'relation') {
      const state = useDataStore.getState();
      const relation = state.entityRelations.find(
        (candidate) =>
          candidate.id === target.relationId &&
          candidate.projectId === this.requireProject(request.context),
      );
      if (!relation) throw new Error('The relation moved or was deleted');
      const read = await this.canonicalRead(
        request,
        'get_entity_relations',
        {
          kind: target.fromKind,
          name: entityReadReference(state, target.fromKind, target.fromId),
        },
        'write-relation',
      );
      const expectedRevision = expectedRevisionFrom(read, 'relation', target.relationId);
      const value = parseJsonObjectFile(content, entry.path);
      const currentFrom = entityDisplayName(state, relation.fromKind, relation.fromId);
      const currentTo = entityDisplayName(state, relation.toKind, relation.toId);
      const nextFromKind = String(value.fromKind ?? relation.fromKind);
      const nextFrom = String(value.from ?? currentFrom);
      const nextToKind = String(value.toKind ?? relation.toKind);
      const nextTo = String(value.to ?? currentTo);
      const relationArguments: Record<string, unknown> = {
        relationId: target.relationId,
        kind: typeof value.kind === 'string' ? value.kind : null,
        expectedRevision,
      };
      if (nextFromKind !== relation.fromKind || nextFrom !== currentFrom) {
        relationArguments.fromKind = nextFromKind;
        relationArguments.from = nextFrom;
      }
      if (nextToKind !== relation.toKind || nextTo !== currentTo) {
        relationArguments.toKind = nextToKind;
        relationArguments.to = nextTo;
      }
      return {
        expectedRevision,
        command: {
          name: 'update_relation_kind',
          arguments: relationArguments,
        },
      };
    }
    if (target.kind === 'memory') {
      const read = await this.canonicalRead(request, 'list_memory', {}, 'write-memory');
      const expectedRevision = expectedRevisionFrom(read, 'memory', target.memoryId);
      return {
        expectedRevision,
        command: {
          name: 'update_memory',
          arguments: {
            memoryId: target.memoryId,
            ...parseJsonObjectFile(content, entry.path),
            expectedRevision,
          },
        },
      };
    }
    if (target.kind === 'category_meta') {
      const read = await this.canonicalRead(
        request,
        'read_node',
        { node: target.categoryId, kind: 'category', prose: false },
        'write-category',
      );
      const expectedRevision = expectedRevisionFrom(read, 'category', target.categoryId);
      return {
        expectedRevision,
        command: {
          name: 'update_category',
          arguments: {
            category: target.categoryId,
            ...parseJsonObjectFile(content, entry.path),
            expectedRevision,
          },
        },
      };
    }
    const current = await this.renderEntry(entry, request);
    if (!current) {
      return this.prepareEmptyScalarFileCommand(entry, content, request);
    }
    if (current !== content && scalarWholeFileReadCoverageRequired(target)) {
      await this.requireCompleteWholeFileRead(entry.path, current, request);
    }
    return this.prepareWorkspaceCommand(
      entry,
      [{ oldText: current, newText: content, replaceAll: false }],
      request,
    );
  }

  private async recordReadCoverage(
    request: AgentToolExecutionRequest,
    path: string,
    content: string,
    start: number,
    end: number,
    totalChars: number,
  ): Promise<void> {
    const key = this.readCoverageKey(request, path);
    const fingerprint = await workspaceContentFingerprint(content);
    const previous = this.readCoverage.get(key);
    const ranges =
      previous?.fingerprint === fingerprint && previous.totalChars === totalChars
        ? [...previous.ranges, { start, end }]
        : [{ start, end }];
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: Array<{ start: number; end: number }> = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (!last || range.start > last.end) {
        merged.push({ ...range });
      } else {
        last.end = Math.max(last.end, range.end);
      }
    }
    this.readCoverage.delete(key);
    this.readCoverage.set(key, { fingerprint, totalChars, ranges: merged });
    while (this.readCoverage.size > MAX_TRACKED_READ_COVERAGE) {
      const oldest = this.readCoverage.keys().next().value as string | undefined;
      if (!oldest) break;
      this.readCoverage.delete(oldest);
    }
  }

  private async requireCompleteWholeFileRead(
    path: string,
    current: string,
    request: AgentToolExecutionRequest,
  ): Promise<void> {
    if (!current) return;
    const coverage = this.readCoverage.get(this.readCoverageKey(request, path));
    const totalChars = codePointLength(current);
    const complete =
      coverage?.totalChars === totalChars &&
      coverage.fingerprint === (await workspaceContentFingerprint(current)) &&
      coverage.ranges.length === 1 &&
      coverage.ranges[0]!.start === 0 &&
      coverage.ranges[0]!.end >= totalChars;
    if (complete) return;
    throw new Error(
      `INCOMPLETE_WHOLE_FILE_READ: write_file cannot replace existing "${path}" ` +
        'because the complete current file has not been read. Continue read_file from its ' +
        'nextOffset until no [File continues ...] marker remains, or use edit_file for a ' +
        'focused change. The file was not changed.',
    );
  }

  private invalidateReadCoverage(request: AgentToolExecutionRequest, path: string): void {
    this.readCoverage.delete(this.readCoverageKey(request, path));
  }

  private readCoverageKey(request: AgentToolExecutionRequest, path: string): string {
    return `${request.sessionId}\u0000${this.requireProject(request.context)}\u0000${path}`;
  }

  private async prepareEmptyScalarFileCommand(
    entry: WorkspaceEntry,
    content: string,
    request: AgentToolExecutionRequest,
  ): Promise<{ expectedRevision: Record<string, string>; command: WorkspaceCommand }> {
    if (!content) throw new Error(`"${entry.path}" already has the requested contents`);
    const target = entry.target;
    if (target.kind === 'node_summary') {
      const read = await this.canonicalRead(
        request,
        'read_node',
        { node: target.nodeId, prose: false },
        'write-empty-summary',
      );
      const expectedRevision = expectedRevisionFrom(read, 'node', target.nodeId);
      return {
        expectedRevision,
        command: {
          name: 'set_node_summary',
          arguments: { node: target.nodeId, summary: content, expectedRevision },
        },
      };
    }
    if (target.kind === 'element_summary' || target.kind === 'element_group') {
      const read = await this.canonicalRead(
        request,
        'read_element',
        { element: target.elementId },
        'write-empty-element-field',
      );
      const expectedRevision = expectedRevisionFrom(read, 'element', target.elementId);
      return {
        expectedRevision,
        command: {
          name: 'update_element',
          arguments: {
            element: target.elementId,
            ...(target.kind === 'element_summary' ? { summary: content } : { groupName: content }),
            expectedRevision,
          },
        },
      };
    }
    if (target.kind === 'storyline_summary') {
      const read = await this.canonicalRead(
        request,
        'get_storyline',
        { storyline: target.storylineId },
        'write-empty-storyline-summary',
      );
      const expectedRevision = expectedRevisionFrom(read, 'storyline', target.storylineId);
      return {
        expectedRevision,
        command: {
          name: 'update_storyline',
          arguments: {
            storyline: target.storylineId,
            summary: content,
            expectedRevision,
          },
        },
      };
    }
    throw new Error(`"${entry.path}" cannot be initialized with write_file`);
  }

  private async prepareCreateCommand(
    path: string,
    content: string,
    request: AgentToolExecutionRequest,
  ): Promise<{ expectedRevision: Record<string, string>; command: WorkspaceCommand }> {
    const projectId = this.requireProject(request.context);
    const segments = path.split('/').filter(Boolean).map(decodePathSegment);
    const file = segments[segments.length - 1] ?? '';
    if (segments[0] === 'memory' && file.endsWith('.json') && segments.length === 2) {
      const read = await this.canonicalRead(request, 'list_memory', {}, 'create-memory');
      const expectedRevision = expectedRevisionFrom(read, 'memory_set', projectId);
      return {
        expectedRevision,
        command: {
          name: 'remember',
          arguments: {
            ...parseJsonObjectFile(content, path),
            expectedRevision,
          },
        },
      };
    }
    const read = await this.canonicalRead(request, 'get_project_brief', {}, 'create-source');
    const expectedRevision = expectedRevisionFrom(read, 'project', projectId);
    if ((segments[0] === 'chapters' || segments[0] === 'drifts') && file === 'prose.md') {
      const title = segments[1]?.trim();
      if (!title || segments.length !== 3) throw new Error('Invalid chapter/drift creation path');
      return {
        expectedRevision,
        command: {
          name: 'create_node',
          arguments: {
            kind: segments[0] === 'chapters' ? 'chapter' : 'drift',
            title,
            body: content,
            expectedRevision,
          },
        },
      };
    }
    if (segments[0] === 'elements' && file === 'body.md' && segments.length === 4) {
      const summary = initialStructuredSummary(content);
      return {
        expectedRevision,
        command: {
          name: 'create_element',
          arguments: {
            category: segments[1],
            name: segments[2],
            body: content,
            ...(summary ? { summary } : {}),
            expectedRevision,
          },
        },
      };
    }
    if (segments[0] === 'storylines' && file === 'body.md' && segments.length === 3) {
      const summary = initialStructuredSummary(content);
      return {
        expectedRevision,
        command: {
          name: 'create_storyline',
          arguments: {
            name: segments[1],
            body: content,
            ...(summary ? { summary } : {}),
            expectedRevision,
          },
        },
      };
    }
    if (segments[0] === 'categories' && file === 'body.md' && segments.length === 3) {
      return {
        expectedRevision,
        command: {
          name: 'create_category',
          arguments: { name: segments[1], body: content, expectedRevision },
        },
      };
    }
    if (segments[0] === 'comments' && file.endsWith('.json') && segments.length === 2) {
      return {
        expectedRevision,
        command: {
          name: 'create_comment',
          arguments: { ...parseJsonObjectFile(content, path), expectedRevision },
        },
      };
    }
    if (segments[0] === 'relations' && file.endsWith('.json') && segments.length === 2) {
      return {
        expectedRevision,
        command: {
          name: 'add_relation',
          arguments: { ...parseJsonObjectFile(content, path), expectedRevision },
        },
      };
    }
    throw new Error(
      'Unsupported creation path. Create prose.md/body.md under chapters, drifts, elements, storylines, or categories; comments, relations, and memory use one JSON file.',
    );
  }

  private async prepareDeleteCommand(
    path: string,
    request: AgentToolExecutionRequest,
  ): Promise<{ expectedRevision: Record<string, string>; command: WorkspaceCommand }> {
    const projectId = this.requireProject(request.context);
    const entry =
      findWorkspaceEntry(projectId, path) ??
      (await this.resolveDynamicMemoryEntry(projectId, path, request)) ??
      primaryWorkspaceEntry(projectId, path, false);
    if (!entry) throw new Error(`No deletable resource exists at "${path}"`);
    const target = entry.target;
    const completeResource = completeStructuralResourcePath(projectId, target);
    if (completeResource && path !== completeResource) {
      throw new Error(
        `"${path}" is one field of an authored resource. Delete "${completeResource}" only when the complete resource should be removed.`,
      );
    }
    if (isNodeTarget(target)) {
      const read = await this.canonicalRead(
        request,
        'read_node',
        { node: target.nodeId, prose: false },
        'delete-node',
      );
      const expectedRevision = expectedRevisionFrom(read, 'node', target.nodeId);
      return {
        expectedRevision,
        command: {
          name: 'delete_node',
          arguments: { node: target.nodeId, expectedRevision },
        },
      };
    }
    if (isElementTarget(target)) {
      const read = await this.canonicalRead(
        request,
        'read_element',
        { element: target.elementId },
        'delete-element',
      );
      const expectedRevision = expectedRevisionFrom(read, 'element', target.elementId);
      return {
        expectedRevision,
        command: {
          name: 'delete_element',
          arguments: { element: target.elementId, expectedRevision },
        },
      };
    }
    if (isStorylineTarget(target)) {
      const read = await this.canonicalRead(
        request,
        'get_storyline',
        { storyline: target.storylineId },
        'delete-storyline',
      );
      const expectedRevision = expectedRevisionFrom(read, 'storyline', target.storylineId);
      return {
        expectedRevision,
        command: {
          name: 'delete_storyline',
          arguments: { storyline: target.storylineId, expectedRevision },
        },
      };
    }
    if (isCategoryTarget(target)) {
      const read = await this.canonicalRead(
        request,
        'read_node',
        { node: target.categoryId, kind: 'category', prose: false },
        'delete-category',
      );
      const expectedRevision = expectedRevisionFrom(read, 'category', target.categoryId);
      return {
        expectedRevision,
        command: {
          name: 'delete_category',
          arguments: { category: target.categoryId, expectedRevision },
        },
      };
    }
    if (target.kind === 'comment') {
      const read = await this.canonicalRead(request, 'list_comments', {}, 'delete-comment');
      const expectedRevision = expectedRevisionFrom(read, 'comment', target.commentId);
      return {
        expectedRevision,
        command: {
          name: 'delete_comment',
          arguments: { commentId: target.commentId, expectedRevision },
        },
      };
    }
    if (target.kind === 'relation') {
      const state = useDataStore.getState();
      const read = await this.canonicalRead(
        request,
        'get_entity_relations',
        {
          kind: target.fromKind,
          name: entityReadReference(state, target.fromKind, target.fromId),
        },
        'delete-relation',
      );
      const expectedRevision = expectedRevisionFrom(read, 'relation', target.relationId);
      return {
        expectedRevision,
        command: {
          name: 'remove_relation',
          arguments: { relationId: target.relationId, expectedRevision },
        },
      };
    }
    if (target.kind === 'memory') {
      const read = await this.canonicalRead(request, 'list_memory', {}, 'delete-memory');
      const expectedRevision = expectedRevisionFrom(read, 'memory', target.memoryId);
      return {
        expectedRevision,
        command: {
          name: 'forget',
          arguments: { memoryId: target.memoryId, expectedRevision },
        },
      };
    }
    throw new Error(`"${path}" is not a complete deletable resource`);
  }

  private async canonicalRead(
    parent: AgentToolExecutionRequest,
    name: string,
    arguments_: Record<string, unknown>,
    suffix: string,
  ): Promise<CanonicalReadResult> {
    const initialRequest: AgentToolExecutionRequest = {
      ...parent,
      callId: `${parent.callId}:workspace:${suffix}`,
      idempotencyKey: `${parent.idempotencyKey}:workspace:${suffix}`,
      name,
      arguments: arguments_,
      access: 'read',
    };
    const initial = await this.executeNestedRead(initialRequest);
    if (!initial.ok) throw new Error(initial.error);
    const envelope = unwrapReadEnvelope(initial.data);
    if (!isTruncatedResult(envelope.value)) return envelope;

    let serialized = envelope.value.preview;
    let next = envelope.value.reread.arguments.offset;
    let pageIndex = 0;
    while (next < envelope.value.totalChars) {
      const pageRequest: AgentToolExecutionRequest = {
        ...parent,
        callId: `${parent.callId}:workspace:${suffix}:page:${pageIndex}`,
        idempotencyKey: `${parent.idempotencyKey}:workspace:${suffix}:page:${pageIndex}`,
        name: 'read_tool_result',
        arguments: {
          resultRef: envelope.value.resultRef,
          offset: next,
          limit: 16_000,
        },
        access: 'read',
      };
      const pageResult = await this.executeNestedRead(pageRequest);
      if (!pageResult.ok) throw new Error(pageResult.error);
      const page = asRecord(unwrapReadEnvelope(pageResult.data).value);
      serialized += String(page.content ?? '');
      const nextOffset = Number(page.nextOffset);
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= next) {
        throw new Error('The canonical read result pager did not advance');
      }
      next = nextOffset;
      pageIndex += 1;
    }
    return {
      value: parseSerializedRead(serialized),
      freshness: envelope.freshness,
    };
  }

  /**
   * Canonical freshness receipts require a durable read lifecycle row. Nested
   * workspace reads are invisible to the provider transcript but still get an
   * auditable child row so the outer edit can prove exactly what it observed.
   */
  private async executeNestedRead(
    request: AgentToolExecutionRequest,
  ): Promise<AgentToolExecutionResult> {
    if (!this.persistence) return this.readRuntime.execute(request);
    const id = `agent-tool:${request.sessionId}:${request.turnId}:${request.callId}`;
    const existing = this.persistence.getToolCall
      ? await this.persistence.getToolCall(id)
      : ((await this.persistence.listToolCalls(request.sessionId)).find(
          (candidate) => candidate.id === id,
        ) ?? null);
    if (existing) {
      if (
        existing.turnId !== request.turnId ||
        existing.callId !== request.callId ||
        existing.name !== request.name ||
        existing.access !== 'read' ||
        existing.idempotencyKey !== request.idempotencyKey ||
        canonicalAgentRuntimeJson(existing.arguments) !==
          canonicalAgentRuntimeJson(request.arguments)
      ) {
        throw new Error('The nested workspace read conflicts with durable provenance');
      }
      if (existing.status === 'completed' || existing.status === 'failed') {
        return persistedNestedReadResult(existing.result);
      }
      await this.persistence.updateToolCall(id, {
        status: 'running',
        startedAt: existing.startedAt ?? this.now(),
      });
    } else {
      const at = this.now();
      await this.persistence.createToolCall({
        id,
        sessionId: request.sessionId,
        turnId: request.turnId,
        callId: request.callId,
        name: request.name,
        access: 'read',
        status: 'running',
        idempotencyKey: request.idempotencyKey,
        arguments: clonePortableData(request.arguments),
        result: null,
        errorCode: null,
        createdAt: at,
        startedAt: at,
        completedAt: null,
      });
    }

    const result = await this.readRuntime.execute(request);
    await this.persistence.updateToolCall(id, {
      status: result.ok ? 'completed' : 'failed',
      result: clonePortableData(result),
      errorCode: result.ok ? null : 'NESTED_WORKSPACE_READ_FAILED',
      completedAt: this.now(),
    });
    return result;
  }

  private requireProject(context: AgentRuntimeContext): string {
    const projectId = context.route.projectId;
    const active = this.getContext();
    if (!projectId || context.route.kind === 'test') {
      throw new Error('The virtual workspace requires a project route');
    }
    if (!active || active.projectId !== projectId) {
      throw new Error('Agent route does not match the active Drifting project');
    }
    return projectId;
  }
}

function completeStructuralResourcePath(projectId: string, target: WorkspaceTarget): string | null {
  if (isNodeTarget(target)) {
    return `/${target.nodeKind === 'chapter' ? 'chapters' : 'drifts'}/${pathSegment(target.nodeName)}`;
  }
  if (isElementTarget(target)) {
    const state = useDataStore.getState();
    const element = state.bookElements.find(
      (candidate) => candidate.id === target.elementId && candidate.projectId === projectId,
    );
    const category = element?.categoryId
      ? state.bookElementCategories.find(
          (candidate) => candidate.id === element.categoryId && candidate.projectId === projectId,
        )
      : null;
    if (!element || !category) {
      throw new Error('The element category moved or was deleted');
    }
    return `/elements/${pathSegment(category.name)}/${pathSegment(target.elementName)}`;
  }
  if (isStorylineTarget(target)) {
    return `/storylines/${pathSegment(target.storylineName)}`;
  }
  if (isCategoryTarget(target)) {
    return `/categories/${pathSegment(target.categoryName)}`;
  }
  return null;
}

export function workspaceCommandFromArguments(arguments_: unknown): WorkspaceCommand | null {
  const record = asRecord(arguments_);
  const raw = record[WORKSPACE_COMMAND_ARGUMENT];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const command = raw as Record<string, unknown>;
  const name = String(command.name ?? '');
  if (!isDriftingWorkspaceCommandName(name)) return null;
  if (
    !command.arguments ||
    typeof command.arguments !== 'object' ||
    Array.isArray(command.arguments)
  ) {
    return null;
  }
  return {
    name,
    arguments: command.arguments as Record<string, unknown>,
  };
}

function workspaceDefinition(name: DriftingWorkspaceReadToolName): AgentToolDefinition {
  const tool = getRegisteredTool(name);
  if (!tool || tool.scope !== 'runtime-virtual' || tool.access !== 'read') {
    throw new Error(`Workspace tool contract "${name}" is unavailable`);
  }
  return {
    name,
    description: tool.description,
    inputSchema: tool.parametersSchema,
    access: 'read',
    validateInput: (input) => {
      if (Value.Check(tool.parametersSchema, input)) return { ok: true, value: input };
      const first = Value.Errors(tool.parametersSchema, input).First();
      return {
        ok: false,
        error: first
          ? `Invalid ${name} arguments at ${first.path || '/'}: ${first.message}`
          : `Invalid ${name} arguments`,
      };
    },
  };
}

function buildWorkspaceEntries(projectId: string): WorkspaceEntry[] {
  const state = useDataStore.getState();
  const project = useProjectStore.getState().currentProject;
  const entries: WorkspaceEntry[] = [
    {
      path: '/README.md',
      writable: false,
      description: 'Project map and working conventions',
      target: { kind: 'overview' },
    },
    {
      path: '/project/facts.json',
      writable: project?.id === projectId,
      description: 'Book-level writing facts and constraints',
      target: { kind: 'project_facts' },
    },
  ];

  const nodes = state.bookNodes.filter((node) => node.projectId === projectId);
  const chapters = nodes
    .filter(isChapter)
    .slice()
    .sort((left, right) => left.bookOrder - right.bookOrder || left.id.localeCompare(right.id));
  const drifts = nodes
    .filter((node) => node.kind === 'drift')
    .slice()
    .sort(
      (left, right) =>
        (left.narrativeOrder ?? Number.MAX_SAFE_INTEGER) -
          (right.narrativeOrder ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
    );
  for (const node of [...chapters, ...drifts]) {
    const base = `/${node.kind === 'chapter' ? 'chapters' : 'drifts'}/${pathSegment(node.title)}`;
    const shared = {
      nodeId: node.id,
      nodeName: node.title,
      nodeKind: node.kind,
    } as const;
    entries.push(
      {
        path: `${base}/prose.md`,
        writable: true,
        description: node.kind === 'chapter' ? 'Live chapter manuscript' : 'Live drift manuscript',
        target: { kind: 'node_prose', ...shared },
      },
      {
        path: `${base}/summary.md`,
        writable: true,
        description: 'Short canonical summary',
        target: { kind: 'node_summary', ...shared },
      },
      {
        path: `${base}/title.txt`,
        writable: true,
        description: 'Canonical title; editing it moves this directory',
        target: { kind: 'node_title', ...shared },
      },
      {
        path: `${base}/meta.json`,
        writable: false,
        description: 'Status, order, and word-count metadata',
        target: { kind: 'node_meta', ...shared },
      },
    );
  }

  const categoryName = (categoryId: string | null) =>
    categoryId
      ? (state.bookElementCategories.find((category) => category.id === categoryId)?.name ??
        '未分类')
      : '未分类';
  for (const element of state.bookElements.filter((item) => item.projectId === projectId)) {
    const base = `/elements/${pathSegment(categoryName(element.categoryId))}/${pathSegment(element.name)}`;
    const shared = { elementId: element.id, elementName: element.name } as const;
    entries.push(
      {
        path: `${base}/body.md`,
        writable: true,
        description: 'Live long-form element canon',
        target: { kind: 'element_body', ...shared },
      },
      {
        path: `${base}/summary.md`,
        writable: true,
        description: 'Element summary',
        target: { kind: 'element_summary', ...shared },
      },
      {
        path: `${base}/name.txt`,
        writable: true,
        description: 'Canonical element name; editing it moves this directory',
        target: { kind: 'element_name', ...shared },
      },
      {
        path: `${base}/aliases.json`,
        writable: true,
        description: 'Alternate names',
        target: { kind: 'element_aliases', ...shared },
      },
      {
        path: `${base}/facts.json`,
        writable: true,
        description: 'Ordered key/value canon facts',
        target: { kind: 'element_facts', ...shared },
      },
      {
        path: `${base}/group.txt`,
        writable: true,
        description: 'Optional secondary grouping label',
        target: { kind: 'element_group', ...shared },
      },
      {
        path: `${base}/category.txt`,
        writable: true,
        description: 'Element category name; editing it moves this directory',
        target: { kind: 'element_category', ...shared },
      },
      {
        path: `${base}/meta.json`,
        writable: false,
        description: 'Complete element profile',
        target: { kind: 'element_meta', ...shared },
      },
    );
  }

  for (const storyline of state.storylines.filter((item) => item.projectId === projectId)) {
    const base = `/storylines/${pathSegment(storyline.name)}`;
    const shared = {
      storylineId: storyline.id,
      storylineName: storyline.name,
    } as const;
    entries.push(
      {
        path: `${base}/body.md`,
        writable: true,
        description: 'Live long-form storyline canon',
        target: { kind: 'storyline_body', ...shared },
      },
      {
        path: `${base}/summary.md`,
        writable: true,
        description: 'Storyline summary',
        target: { kind: 'storyline_summary', ...shared },
      },
      {
        path: `${base}/name.txt`,
        writable: true,
        description: 'Canonical storyline name; editing it moves this directory',
        target: { kind: 'storyline_name', ...shared },
      },
      {
        path: `${base}/facts.json`,
        writable: true,
        description: 'Ordered key/value storyline facts',
        target: { kind: 'storyline_facts', ...shared },
      },
      {
        path: `${base}/chapters.json`,
        writable: true,
        description: 'Member chapters and primary-storyline flags in reading order',
        target: { kind: 'storyline_chapters', ...shared },
      },
      {
        path: `${base}/meta.json`,
        writable: false,
        description: 'Complete storyline profile',
        target: { kind: 'storyline_meta', ...shared },
      },
    );
  }

  for (const category of state.bookElementCategories.filter(
    (item) => item.projectId === projectId,
  )) {
    const base = `/categories/${pathSegment(category.name)}`;
    const shared = { categoryId: category.id, categoryName: category.name } as const;
    entries.push(
      {
        path: `${base}/body.md`,
        writable: true,
        description: 'Live long-form category canon',
        target: { kind: 'category_body', ...shared },
      },
      {
        path: `${base}/meta.json`,
        writable: true,
        description: 'Category metadata',
        target: { kind: 'category_meta', ...shared },
      },
    );
  }

  const materialTitleCounts = new Map<string, number>();
  const materials = state.libraryItems.filter((item) => item.projectId === projectId);
  for (const item of materials) {
    const title = item.title || '(untitled)';
    materialTitleCounts.set(title, (materialTitleCounts.get(title) ?? 0) + 1);
  }
  for (const item of materials) {
    const title = item.title || '(untitled)';
    const duplicateSuffix =
      (materialTitleCounts.get(title) ?? 0) > 1 ? `~${item.id.slice(0, 8)}` : '';
    entries.push({
      path: `/materials/${pathSegment(title)}${duplicateSuffix}.${item.kind === 'text' ? 'md' : 'json'}`,
      writable: false,
      description: `${item.kind} material from ${item.source}`,
      target: { kind: 'material', materialId: item.id, materialTitle: title },
    });
  }

  entries.push(
    {
      path: '/comments.json',
      writable: false,
      description: 'Editorial comments and TODOs',
      target: { kind: 'comments' },
    },
    {
      path: '/memory.json',
      writable: false,
      description: 'Standing guidance index; individual proposals live under /memory',
      target: { kind: 'memory_collection' },
    },
  );
  for (const comment of state.comments.filter((item) => item.projectId === projectId)) {
    entries.push({
      path: `/comments/${pathSegment(comment.id)}.json`,
      writable: true,
      description: `${comment.kind} · ${comment.status}`,
      target: { kind: 'comment', commentId: comment.id },
    });
  }
  for (const relation of state.entityRelations.filter((item) => item.projectId === projectId)) {
    entries.push({
      path: `/relations/${pathSegment(relation.id)}.json`,
      writable: true,
      description: relation.kind || 'related',
      target: {
        kind: 'relation',
        relationId: relation.id,
        fromKind: relation.fromKind,
        fromId: relation.fromId,
      },
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
}

function workspaceEntryDisplayName(entry: WorkspaceEntry): string {
  const target = entry.target;
  switch (target.kind) {
    case 'overview':
      return '项目说明';
    case 'project_facts':
      return '项目设定';
    case 'node_prose':
      return `${target.nodeName}正文`;
    case 'node_summary':
      return `${target.nodeName}摘要`;
    case 'node_title':
      return `${target.nodeName}标题`;
    case 'node_meta':
      return `${target.nodeName}状态与顺序`;
    case 'element_body':
      return `${target.elementName}设定正文`;
    case 'element_summary':
      return `${target.elementName}摘要`;
    case 'element_name':
      return `${target.elementName}名称`;
    case 'element_aliases':
      return `${target.elementName}别名`;
    case 'element_facts':
      return `${target.elementName}事实`;
    case 'element_group':
      return `${target.elementName}分组`;
    case 'element_category':
      return `${target.elementName}分类`;
    case 'element_meta':
      return `${target.elementName}完整档案`;
    case 'storyline_body':
      return `${target.storylineName}正文`;
    case 'storyline_summary':
      return `${target.storylineName}摘要`;
    case 'storyline_name':
      return `${target.storylineName}名称`;
    case 'storyline_facts':
      return `${target.storylineName}事实`;
    case 'storyline_chapters':
      return `${target.storylineName}章节`;
    case 'storyline_meta':
      return `${target.storylineName}完整档案`;
    case 'category_body':
      return `${target.categoryName}分类设定`;
    case 'category_meta':
      return `${target.categoryName}分类档案`;
    case 'material':
      return target.materialTitle;
    case 'comments':
      return '编辑批注';
    case 'comment':
      return '批注';
    case 'relation':
      return '实体关系';
    case 'memory_collection':
      return '长期写作指南';
    case 'memory':
      return `写作指南 ${target.memoryId.slice(0, 8)}`;
  }
}

function workspaceDirectoryDisplayName(
  path: string,
  descendants: readonly WorkspaceEntry[],
): string {
  const rootNames: Record<string, string> = {
    '/chapters': '章节',
    '/drifts': '灵感',
    '/elements': '故事元素',
    '/storylines': '故事线',
    '/categories': '元素分类',
    '/materials': '参考素材',
    '/project': '项目设定',
    '/comments': '编辑批注',
    '/relations': '实体关系',
    '/memory': '长期写作指南',
  };
  if (rootNames[path]) return rootNames[path];

  const targets = descendants.map((entry) => entry.target);
  const nodeTarget = targets.find(isNodeTarget);
  if (nodeTarget && (path.startsWith('/chapters/') || path.startsWith('/drifts/'))) {
    return nodeTarget.nodeName;
  }
  const segments = path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? '';
  if (segments[0] === 'elements' && segments.length >= 3) {
    return targets.find(isElementTarget)?.elementName ?? decodePathSegment(lastSegment);
  }
  if (segments[0] === 'storylines') {
    return targets.find(isStorylineTarget)?.storylineName ?? decodePathSegment(lastSegment);
  }
  if (segments[0] === 'categories') {
    const category = targets.find(
      (target): target is Extract<WorkspaceTarget, { categoryName: string }> =>
        target.kind === 'category_body' || target.kind === 'category_meta',
    );
    return category?.categoryName ?? decodePathSegment(lastSegment);
  }
  return decodePathSegment(lastSegment || path);
}

function describeWorkspaceDirectory(
  projectId: string,
  path: string,
  descendants: readonly WorkspaceEntry[],
): string {
  const nodeTarget = descendants.map((entry) => entry.target).find(isNodeTarget);
  if (nodeTarget && (path.startsWith('/chapters/') || path.startsWith('/drifts/'))) {
    const node = currentNode(nodeTarget.nodeId, projectId);
    const summary = compactDescription(node.summary, 220);
    return [
      node.kind === 'chapter' ? 'Chapter' : 'Drift',
      `${node.wordCount.toLocaleString('en-US')} words`,
      node.writingStatus,
      summary,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  const entityCount = new Set(
    descendants
      .map((entry) => workspaceEntityKey(entry.target))
      .filter((value): value is string => Boolean(value)),
  ).size;
  const labels: Record<string, string> = {
    '/chapters': 'Chapters in reading order',
    '/drifts': 'Free-floating inspiration notes',
    '/elements': 'Characters, places, objects, and other canon',
    '/storylines': 'Storyline canon',
    '/categories': 'Element category canon',
    '/materials': 'Reference materials',
    '/project': 'Book-level facts and constraints',
    '/comments': 'Editorial comments and TODOs',
    '/relations': 'Curated relationships between story entities',
  };
  const label = labels[path] ?? 'Directory';
  return entityCount > 0 ? `${label} · ${entityCount} items` : label;
}

function compareWorkspaceListItems(
  projectId: string,
  prefix: string,
  left: WorkspaceListItem,
  right: WorkspaceListItem,
): number {
  if (prefix === '/chapters' || prefix === '/drifts') {
    const leftNode = listedDirectoryNode(projectId, left);
    const rightNode = listedDirectoryNode(projectId, right);
    if (leftNode && rightNode) {
      const leftOrder = isChapter(leftNode)
        ? leftNode.bookOrder
        : (leftNode.narrativeOrder ?? Number.MAX_SAFE_INTEGER);
      const rightOrder = isChapter(rightNode)
        ? rightNode.bookOrder
        : (rightNode.narrativeOrder ?? Number.MAX_SAFE_INTEGER);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    }
  }
  if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
  return left.path.localeCompare(right.path, 'zh-CN');
}

function listedDirectoryNode(projectId: string, item: WorkspaceListItem) {
  const target = item.descendants?.map((entry) => entry.target).find(isNodeTarget);
  return target ? currentNode(target.nodeId, projectId) : null;
}

function compactDescription(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function findWorkspaceEntry(projectId: string, path: string): WorkspaceEntry | undefined {
  return buildWorkspaceEntries(projectId).find((candidate) => candidate.path === path);
}

function requireWorkspaceFileEntry(
  projectId: string,
  value: unknown,
  writable: boolean,
): WorkspaceEntry {
  const path = resolveWorkspacePath(projectId, value);
  const direct = findWorkspaceEntry(projectId, path);
  const entry = direct ?? primaryWorkspaceEntry(projectId, path, writable);
  if (!entry) {
    throw new Error(`No ${writable ? 'writable ' : ''}file exists at "${path}".`);
  }
  return entry;
}

function primaryWorkspaceEntry(
  projectId: string,
  directory: string,
  writable = false,
): WorkspaceEntry | undefined {
  if (directory === '/') return undefined;
  const priorities = ['prose.md', 'body.md', 'facts.json', 'summary.md', 'README.md'];
  const candidates = buildWorkspaceEntries(projectId).filter(
    (entry) =>
      pathIsWithin(entry.path, directory) &&
      entry.path !== directory &&
      (!writable || entry.writable),
  );
  const entityKeys = new Set(
    candidates
      .map((entry) => workspaceEntityKey(entry.target))
      .filter((key): key is string => key !== null),
  );
  if (entityKeys.size > 1 || (entityKeys.size === 0 && candidates.length > 1)) {
    return undefined;
  }
  return candidates.sort((left, right) => {
    const leftName = left.path.split('/').pop() ?? '';
    const rightName = right.path.split('/').pop() ?? '';
    const leftPriority = priorities.indexOf(leftName);
    const rightPriority = priorities.indexOf(rightName);
    const leftRank = leftPriority < 0 ? priorities.length : leftPriority;
    const rightRank = rightPriority < 0 ? priorities.length : rightPriority;
    return leftRank - rightRank || left.path.localeCompare(right.path, 'zh-CN');
  })[0];
}

function renderOverview(value: unknown, entries: readonly WorkspaceEntry[]): string {
  const overview = asRecord(value);
  const counts = asRecord(overview.counts);
  const writable = entries.filter((entry) => entry.writable).length;
  return [
    `# ${String(overview.name ?? 'Drifting project')}`,
    '',
    String(overview.description ?? '').trim(),
    '',
    '## Workspace',
    '',
    '- `/chapters/*/prose.md`: live manuscript; exact replacements are writable',
    '- `/drifts/*/prose.md`: live drift notes; exact replacements are writable',
    '- `/elements/*/*`: character, setting, and object canon',
    '- Create a new category at `/categories/<category>/body.md`, then create its elements at `/elements/<category>/<element>/body.md`; an empty category is still a valid directory',
    '- `/storylines/*`: storyline canon and chapter membership',
    '- `/comments/*.json`: editorial notes and TODOs',
    '- `/relations/*.json`: curated entity relationships',
    '- `/project/facts.json`: book-level constraints',
    '- `/materials/*`: reference material (read-only)',
    '',
    'Prose files accept the editor schema directly: `#`-`###` headings, paragraphs, blockquotes, horizontal rules, hard breaks, bold, italic, strike, underline, and safe links. Other Markdown styling is unwrapped to plain prose when saved.',
    '',
    'Use list_files to browse, read_file to inspect, grep to search, edit_file for focused changes, write_file to create resources, and delete_file to remove a complete resource.',
    'Chapters behave like ordinary files. Saving, concurrent-edit protection, review, and undo are automatic.',
    '',
    '## Counts',
    '',
    `- chapters: ${Number(counts.chapters ?? 0)}`,
    `- drifts: ${Number(counts.drifts ?? 0)}`,
    `- storylines: ${Number(counts.storylines ?? 0)}`,
    `- elements: ${Number(counts.elements ?? 0)}`,
    `- writable files: ${writable}`,
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n')
    .trim();
}

function renderComments(value: unknown): string {
  const comments = recordArray(value, 'comments');
  if (comments.length === 0) return '# Editorial comments\n\nNo comments.';
  return [
    '# Editorial comments',
    '',
    ...comments.flatMap((comment, index) => {
      const target = String(comment.target ?? comment.targetName ?? 'project');
      const author = String(comment.author ?? 'unknown');
      const status = String(comment.status ?? 'open');
      const kind = String(comment.kind ?? 'note');
      const quote = String(comment.quote ?? '').trim();
      const body = String(comment.body ?? '').trim();
      return [
        `## ${index + 1}. ${target}`,
        '',
        `- ${kind} · ${status} · ${author}`,
        ...(quote ? [`- quote: ${quote}`] : []),
        '',
        body || '(empty)',
        '',
      ];
    }),
  ]
    .join('\n')
    .trim();
}

function renderMemories(value: unknown): string {
  const memories = recordArray(value, 'memories');
  if (memories.length === 0) return '# Author guidance\n\nNo standing guidance.';
  return [
    '# Author guidance',
    '',
    ...memories.flatMap((memory) => {
      const kind = String(memory.kind ?? 'guidance');
      const body = String(memory.body ?? '').trim();
      return body ? [`## ${kind}`, '', body, ''] : [];
    }),
  ]
    .join('\n')
    .trim();
}

function renderMemoryFile(memory: Record<string, unknown>): string {
  return prettyJson({
    kind: memory.kind,
    body: memory.body,
    targetKind: memory.targetKind ?? null,
    target: memory.target ?? null,
    targetBlockId: memory.targetBlockId ?? null,
    supersedesId: memory.supersedesId ?? null,
  });
}

function compactProseBlocks(value: unknown): CompactProseBlock[] {
  const text = String(value ?? '');
  const blocks: CompactProseBlock[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\d+)\t(.*)$/.exec(line);
    if (!match) continue;
    const block = Number(match[1]);
    const displayText = match[2] ?? '';
    const typePrefix = compactTypePrefix(displayText);
    blocks.push({
      block,
      displayText,
      typePrefix,
      rawText: typePrefix ? displayText.slice(typePrefix.length) : displayText,
    });
  }
  return blocks;
}

function compactTypePrefix(text: string): string {
  const heading = /^#{1,3} /u.exec(text);
  if (heading) return heading[0];
  if (text.startsWith('> ')) return '> ';
  if (text === '---') return '---';
  return '';
}

function expectedRevisionFrom(
  read: CanonicalReadResult,
  entityKind: string,
  entityId: string,
): Record<string, string> {
  const observation = read.freshness?.observations.find(
    (candidate) => candidate.entityKind === entityKind && candidate.entityId === entityId,
  );
  if (!read.freshness || !observation) {
    throw new Error('The runtime could not obtain an exact revision for this file; retry the edit');
  }
  return {
    receiptId: read.freshness.receiptId,
    observationId: observation.id,
    revision: observation.revision,
  };
}

function unwrapReadEnvelope(value: unknown): CanonicalReadResult {
  const envelope = asRecord(value);
  if (!('result' in envelope) || !('freshness' in envelope)) {
    return { value, freshness: null };
  }
  const rawFreshness = asRecord(envelope.freshness);
  const observations = Array.isArray(rawFreshness.observations)
    ? rawFreshness.observations.flatMap((raw) => {
        const row = asRecord(raw);
        return typeof row.id === 'string' &&
          typeof row.entityKind === 'string' &&
          typeof row.entityId === 'string' &&
          typeof row.revision === 'string'
          ? [
              {
                id: row.id,
                entityKind: row.entityKind,
                entityId: row.entityId,
                revision: row.revision,
              },
            ]
          : [];
      })
    : [];
  return {
    value: envelope.result,
    freshness:
      typeof rawFreshness.receiptId === 'string'
        ? { receiptId: rawFreshness.receiptId, observations }
        : null,
  };
}

function isTruncatedResult(value: unknown): value is {
  truncated: true;
  resultRef: string;
  preview: string;
  totalChars: number;
  reread: { arguments: { offset: number } };
} {
  const row = asRecord(value);
  const reread = asRecord(row.reread);
  const arguments_ = asRecord(reread.arguments);
  return (
    row.truncated === true &&
    typeof row.resultRef === 'string' &&
    typeof row.preview === 'string' &&
    typeof row.totalChars === 'number' &&
    typeof arguments_.offset === 'number'
  );
}

function parseSerializedRead(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function persistedNestedReadResult(value: unknown): AgentToolExecutionResult {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  ) {
    return value as AgentToolExecutionResult;
  }
  throw new Error('The nested workspace read lost its durable result');
}

function workspaceEntityKey(target: WorkspaceTarget): string | null {
  if (isNodeTarget(target)) return `${target.nodeKind}:${target.nodeName}`;
  if (isElementTarget(target)) return `element:${target.elementName}`;
  if (isStorylineTarget(target)) return `storyline:${target.storylineName}`;
  if (isCategoryTarget(target)) return `category:${target.categoryName}`;
  return null;
}

function workspaceSearchEntryForField(
  entries: readonly WorkspaceEntry[],
  field: string,
): WorkspaceEntry | undefined {
  const kindsByField: Record<string, WorkspaceTarget['kind'][]> = {
    title: ['node_title', 'element_name', 'storyline_name', 'category_meta'],
    summary: ['node_summary', 'element_summary', 'storyline_summary'],
    alias: ['element_aliases'],
    fact: ['element_facts', 'storyline_facts', 'category_meta'],
    prose: ['node_prose', 'element_body', 'storyline_body', 'category_body'],
  };
  const allowed = kindsByField[field] ?? kindsByField.prose!;
  return entries.find((entry) => allowed.includes(entry.target.kind));
}

function containsLiteralQuery(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function literalWorkspaceMatches(
  entry: WorkspaceEntry,
  content: string,
  query: string,
): Array<{ path: string; name: string; line: number; snippet: string }> {
  const occurrences: Array<{ path: string; name: string; line: number; snippet: string }> = [];
  let cursor = 0;
  while (cursor <= content.length) {
    const index = content.indexOf(query, cursor);
    if (index < 0) break;
    const lineStart = content.lastIndexOf('\n', index - 1) + 1;
    const nextBreak = content.indexOf('\n', index + query.length);
    const lineEnd = nextBreak < 0 ? content.length : nextBreak;
    occurrences.push({
      path: entry.path,
      name: workspaceEntryDisplayName(entry),
      line: content.slice(0, index).split('\n').length,
      snippet: compactDescription(content.slice(lineStart, lineEnd), 500),
    });
    cursor = index + query.length;
  }
  return occurrences;
}

function isNodeTarget(
  target: WorkspaceTarget,
): target is Extract<WorkspaceTarget, { nodeId: string }> {
  return 'nodeId' in target;
}

function isElementTarget(
  target: WorkspaceTarget,
): target is Extract<WorkspaceTarget, { elementId: string }> {
  return 'elementId' in target;
}

function isStorylineTarget(
  target: WorkspaceTarget,
): target is Extract<WorkspaceTarget, { storylineId: string }> {
  return 'storylineId' in target;
}

function isCategoryTarget(
  target: WorkspaceTarget,
): target is Extract<WorkspaceTarget, { categoryId: string }> {
  return 'categoryId' in target;
}

type WorkspaceProseTarget =
  | {
      entityType: 'node';
      id: string;
      name: string;
      nodeKind: 'chapter' | 'drift';
    }
  | {
      entityType: 'element' | 'storyline' | 'category';
      id: string;
      name: string;
    };

function workspaceProseTarget(target: WorkspaceTarget): WorkspaceProseTarget | null {
  if (target.kind === 'node_prose') {
    return {
      entityType: 'node',
      id: target.nodeId,
      name: target.nodeName,
      nodeKind: target.nodeKind,
    };
  }
  if (target.kind === 'element_body') {
    return { entityType: 'element', id: target.elementId, name: target.elementName };
  }
  if (target.kind === 'storyline_body') {
    return {
      entityType: 'storyline',
      id: target.storylineId,
      name: target.storylineName,
    };
  }
  if (target.kind === 'category_body') {
    return {
      entityType: 'category',
      id: target.categoryId,
      name: target.categoryName,
    };
  }
  return null;
}

function scalarWholeFileReadCoverageRequired(target: WorkspaceTarget): boolean {
  switch (target.kind) {
    case 'node_summary':
    case 'node_title':
    case 'element_summary':
    case 'element_name':
    case 'element_group':
    case 'storyline_summary':
    case 'storyline_name':
      return true;
    default:
      return false;
  }
}

function normalizeEntityKind(kind: string): string {
  return kind === 'node' ? 'chapter' : kind;
}

function normalizeVirtualPath(value: unknown): string {
  const raw = String(value ?? '/').trim() || '/';
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  const normalized = prefixed.length > 1 ? prefixed.replace(/\/+$/g, '') : prefixed;
  if (normalized.includes('\u0000') || normalized.split('/').includes('..')) {
    throw new Error('Invalid virtual workspace path');
  }
  return normalized;
}

/**
 * Let the model address an authored resource by its semantic directory. The
 * virtual filesystem still resolves the operation to the same certified
 * prose/body command; this only removes product-internal filename trivia from
 * the public write contract.
 */
function normalizeWorkspaceWritePath(value: unknown): string {
  const path = normalizeVirtualPath(value);
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 2 && (segments[0] === 'chapters' || segments[0] === 'drifts')) {
    return `${path}/prose.md`;
  }
  if (segments.length === 2 && (segments[0] === 'storylines' || segments[0] === 'categories')) {
    return `${path}/body.md`;
  }
  if (segments.length === 3 && segments[0] === 'elements') {
    return `${path}/body.md`;
  }
  return path;
}

function workspaceReadModelData(value: unknown): string {
  const result = asRecord(value);
  const path = typeof result.path === 'string' ? result.path : '/';
  if (Array.isArray(result.files)) {
    const lines = result.files.flatMap((raw) => {
      const file = asRecord(raw);
      if (typeof file.path !== 'string') return [];
      const shownPath = file.type === 'directory' ? `${file.path}/` : file.path;
      return [shownPath];
    });
    if (result.truncated === true) lines.push('[More entries exist in this directory.]');
    if (typeof result.creationGuide === 'string' && result.creationGuide.trim()) {
      lines.push('', 'Creation guide:', result.creationGuide.trim());
    }
    return [`Directory ${path}`, ...lines].join('\n');
  }
  if (typeof result.content === 'string') {
    const wordCount =
      typeof result.wordCount === 'number' && Number.isFinite(result.wordCount)
        ? `\nWord count: ${result.wordCount}`
        : '';
    const continuation =
      result.truncated === true && typeof result.nextOffset === 'number'
        ? `\n\n[File continues at character ${result.nextOffset}.]`
        : '';
    return `${path}${wordCount}\n\n${result.content}${continuation}`;
  }
  if (Array.isArray(result.matches)) {
    const query = typeof result.query === 'string' ? result.query : '';
    const matches = result.matches.flatMap((raw) => {
      const match = asRecord(raw);
      if (typeof match.path !== 'string') return [];
      const line = typeof match.line === 'number' ? `:${match.line}` : '';
      const snippet = typeof match.snippet === 'string' ? match.snippet : '';
      return [`${match.path}${line}: ${snippet}`];
    });
    const total =
      typeof result.total === 'number' && Number.isFinite(result.total)
        ? Math.max(0, Math.trunc(result.total))
        : matches.length;
    const header =
      result.exact === true ? `Exact literal occurrences: ${total}` : `Search matches: ${total}`;
    if (matches.length === 0) {
      return `${header}\nNo matches for ${JSON.stringify(query)} under ${path}.`;
    }
    if (result.truncated === true) matches.push('[More matches exist.]');
    return [header, ...matches].join('\n');
  }
  return prettyJson(value);
}

function workspaceDirectoryCreationGuide(path: string): string | null {
  if (path === '/') {
    return 'List the relevant parent directory before creating an unfamiliar resource; its listing gives the exact one-write creation form.';
  }
  if (path === '/chapters' || path === '/drifts') {
    const root = path === '/chapters' ? 'chapters' : 'drifts';
    return (
      `Create one resource with one write_file to /${root}/<title>/prose.md containing its complete initial prose. ` +
      'title.txt and meta.json are generated automatically; do not create or rewrite them. If the author requests a summary, write summary.md after creation.'
    );
  }
  if (path === '/elements' || path.startsWith('/elements/')) {
    return (
      'Elements are canon entities such as people, places, organizations, and objects. Author terms 灵感 or 漂移 belong under /drifts, never an /elements/灵感 category unless explicitly requested. Create one element with one write_file to /elements/<category>/<name>/body.md containing its complete initial profile. ' +
      'If the author did not name a category, list /elements once and reuse the closest existing category; create a new category only when no suitable one exists. ' +
      'name.txt, category.txt, and meta.json are generated automatically; do not create or rewrite them. A clearly labeled 摘要 or Summary section inside the initial body.md initializes the separate summary field in the same transaction; otherwise write summary.md separately when requested. aliases.json, facts.json, and group.txt are optional.'
    );
  }
  if (path === '/storylines' || path === '/categories') {
    const root = path === '/storylines' ? 'storylines' : 'categories';
    return (
      `Create one resource with one write_file to /${root}/<name>/body.md. ` +
      'Generated identity and metadata files do not need a separate write.'
    );
  }
  if (path === '/comments') {
    return (
      'Create exactly one JSON file per note or TODO at /comments/<descriptive-name>.json with ' +
      '{"body":"核对时间线","kind":"todo","targetKind":"node","target":"灰港失踪案"}. ' +
      'Use kind "note" for an author note. The placeholder path is not an existing file; choose a descriptive filename and do not read other comments to infer this schema.'
    );
  }
  if (path === '/relations') {
    return (
      'Create exactly one JSON file per relationship at /relations/<descriptive-name>.json with ' +
      '{"fromKind":"element","from":"伊莱","toKind":"element","to":"灰潮档案局","kind":"隶属"}. ' +
      'Use exact entity names. One file creates one edge: "both A and B relate to C" requires separate A-to-C and B-to-C files, in addition to any requested A-to-B edge. ' +
      'Wait until every referenced resource creation has succeeded before issuing relation writes; do not put them in the same tool-call batch. ' +
      'The placeholder path is not an existing file; choose a descriptive filename and do not read other relations to infer this schema.'
    );
  }
  return null;
}

function resolveWorkspacePath(projectId: string, value: unknown): string {
  const normalized = normalizeVirtualPath(value);
  if (normalized === '/') return normalized;
  const entries = buildWorkspaceEntries(projectId);
  const paths = new Set<string>(['/']);
  for (const entry of entries) {
    paths.add(entry.path);
    const segments = entry.path.split('/').filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      paths.add(`/${segments.slice(0, index).join('/')}`);
    }
  }
  if (paths.has(normalized)) return normalized;
  const chapterAlias = resolveChapterOrdinalAlias(entries, normalized);
  if (chapterAlias && paths.has(chapterAlias)) return chapterAlias;
  const suffixMatches = [...paths].filter((path) => path.endsWith(normalized));
  return suffixMatches.length === 1 ? suffixMatches[0]! : normalized;
}

const VIRTUAL_WORKSPACE_ROOTS = new Set([
  '/chapters',
  '/drifts',
  '/elements',
  '/storylines',
  '/categories',
  '/materials',
  '/project',
  '/comments',
  '/relations',
  '/memory',
]);

function isVirtualWorkspaceRoot(path: string): boolean {
  return VIRTUAL_WORKSPACE_ROOTS.has(path);
}

function entityDisplayName(
  state: ReturnType<typeof useDataStore.getState>,
  kind: string,
  id: string,
): string {
  if (kind === 'node') return state.bookNodes.find((item) => item.id === id)?.title ?? id;
  if (kind === 'element') {
    return state.bookElements.find((item) => item.id === id)?.name ?? id;
  }
  if (kind === 'storyline') {
    return state.storylines.find((item) => item.id === id)?.name ?? id;
  }
  if (kind === 'category') {
    return state.bookElementCategories.find((item) => item.id === id)?.name ?? id;
  }
  if (kind === 'library_item') {
    return state.libraryItems.find((item) => item.id === id)?.title || id;
  }
  if (kind === 'comment') return `批注 ${id.slice(0, 8)}`;
  return id;
}

function entityReadReference(
  state: ReturnType<typeof useDataStore.getState>,
  kind: string,
  id: string,
): string {
  return kind === 'node' || kind === 'element' || kind === 'storyline' || kind === 'category'
    ? entityDisplayName(state, kind, id)
    : id;
}

function initialStructuredSummary(markdown: string): string | null {
  const lines = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^\s{0,3}(#{1,6})\s+(摘要|summary)\s*#*\s*$/iu.exec(lines[index] ?? '');
    if (!heading) continue;
    const level = heading[1]?.length ?? 6;
    const collected: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = /^\s{0,3}(#{1,6})\s+/u.exec(lines[cursor] ?? '');
      if (next && (next[1]?.length ?? 6) <= level) break;
      collected.push(lines[cursor] ?? '');
    }
    const summary = collected.join('\n').trim();
    return summary || null;
  }
  return null;
}

function parseJsonObjectFile(value: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error(
      `"${path}" must contain valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`"${path}" must contain one JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseJsonArrayFile(value: string, path: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error(
      `"${path}" must contain valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`"${path}" must contain one JSON array`);
  }
  return parsed;
}

function workspacePathExists(
  projectId: string,
  entries: readonly WorkspaceEntry[],
  path: string,
): boolean {
  if (path === '/') return true;
  return (
    isEmptyElementCategoryDirectory(projectId, path) ||
    entries.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`))
  );
}

function isEmptyElementCategoryDirectory(projectId: string, path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0] !== 'elements') return false;
  return useDataStore
    .getState()
    .bookElementCategories.some(
      (category) => category.projectId === projectId && pathSegment(category.name) === segments[1],
    );
}

function resolveChapterOrdinalAlias(
  entries: readonly WorkspaceEntry[],
  normalized: string,
): string | null {
  const segments = normalized.split('/').filter(Boolean);
  const referenceIndex = segments[0] === 'chapters' ? 1 : 0;
  const reference = segments[referenceIndex];
  if (!reference) return null;
  const ordinal = parseChapterOrdinal(decodePathSegment(reference));
  if (ordinal === null) return null;

  const numericTitleMatches = entries.filter((entry) => {
    const target = entry.target;
    if (!isNodeTarget(target) || target.kind !== 'node_prose' || target.nodeKind !== 'chapter') {
      return false;
    }
    const title = target.nodeName.trim();
    return /^\d+$/.test(title) && Number(title) === ordinal;
  });
  const orderMatches = entries.filter((entry) => {
    const target = entry.target;
    if (!isNodeTarget(target) || target.kind !== 'node_prose' || target.nodeKind !== 'chapter') {
      return false;
    }
    const node = useDataStore
      .getState()
      .bookNodes.find((candidate) => candidate.id === target.nodeId);
    return node?.bookOrder === ordinal;
  });
  const matches = numericTitleMatches.length > 0 ? numericTitleMatches : orderMatches;
  if (matches.length !== 1) return null;
  const base = matches[0]!.path.replace(/\/prose\.md$/, '');
  const remainder = segments.slice(referenceIndex + 1);
  return remainder.length > 0 ? `${base}/${remainder.join('/')}` : base;
}

function parseChapterOrdinal(value: string): number | null {
  const match = /^第?([〇零一二三四五六七八九十百两\d]+)章?$/.exec(value.trim());
  if (!match) return null;
  const raw = match[1]!;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const digits: Record<string, number> = {
    〇: 0,
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (!/[十百]/.test(raw)) {
    const joined = [...raw].map((character) => digits[character]).join('');
    return /^\d+$/.test(joined) ? Number(joined) : null;
  }
  let total = 0;
  let current = 0;
  for (const character of raw) {
    if (character === '十' || character === '百') {
      const unit = character === '十' ? 10 : 100;
      total += (current || 1) * unit;
      current = 0;
      continue;
    }
    const digit = digits[character];
    if (digit === undefined) return null;
    current = digit;
  }
  return total + current;
}

function pathSegment(value: string): string {
  const cleaned = value.trim() || '(untitled)';
  return cleaned.replaceAll('%', '%25').replaceAll('/', '%2F').replaceAll('\\', '%5C');
}

function decodePathSegment(value: string): string {
  return value.replaceAll('%5C', '\\').replaceAll('%2F', '/').replaceAll('%25', '%');
}

function pathIsWithin(path: string, prefix: string): boolean {
  return prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);
}

function currentNode(nodeId: string, projectId: string) {
  const node = useDataStore
    .getState()
    .bookNodes.find((candidate) => candidate.id === nodeId && candidate.projectId === projectId);
  if (!node) throw new Error('The virtual file moved or was deleted; call list_files again');
  return node;
}

function parseKvFile(value: string): KvEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('The edited facts file is not valid JSON');
  }
  const rows = kvList(parsed);
  if (!Array.isArray(parsed) || rows.length !== parsed.length) {
    throw new Error('Facts files must be an array of {"key": string, "value": string} rows');
  }
  return rows;
}

function kvList(value: unknown): KvEntry[] {
  if (typeof value === 'string') return parseKv(value);
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const row = asRecord(raw);
    return typeof row.key === 'string' && typeof row.value === 'string'
      ? [{ key: row.key, value: row.value }]
      : [];
  });
}

function parseStringArrayFile(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('The edited aliases file is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Aliases files must be a JSON array of strings');
  }
  return parsed;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordArray(value: unknown, key: string): Record<string, unknown>[] {
  const raw = asRecord(value)[key];
  return Array.isArray(raw) ? raw.map(asRecord) : [];
}

function recordBoolean(value: unknown, key: string): boolean {
  return asRecord(value)[key] === true;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

async function workspaceContentFingerprint(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('SHA-256 is unavailable; whole-file read coverage cannot be verified');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sliceCodePoints(value: string, offset: number, limit: number): string {
  return Array.from(value)
    .slice(offset, offset + limit)
    .join('');
}
