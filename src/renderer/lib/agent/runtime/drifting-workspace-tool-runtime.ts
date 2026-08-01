import { Value } from '@sinclair/typebox/value';

import { isChapter } from '../../../domain/book-node';
import { parseKv, type KvEntry } from '../../../domain/kv';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import {
  canonicalAgentRuntimeJson,
  type AgentRuntimePersistenceRepository,
} from '../../../sqlite-repo/agent-runtime-persistence-repo';
import {
  getActiveAgentToolContext,
  type AgentToolContext,
} from '../tool-handlers';
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

export const DRIFTING_WORKSPACE_READ_TOOLS = [
  'list_files',
  'read_file',
  'grep',
] as const;

export const DRIFTING_WORKSPACE_EDIT_TOOL = 'edit_file' as const;

type WorkspaceReadToolName = (typeof DRIFTING_WORKSPACE_READ_TOOLS)[number];

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
  | { kind: 'memory' };

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
  name:
    | 'edit_blocks'
    | 'rename_node'
    | 'set_node_summary'
    | 'update_element'
    | 'update_storyline'
    | 'update_project_facts';
  arguments: Record<string, unknown>;
}

const DEFAULT_READ_LIMIT = 16_000;
const MAX_LISTED_FILES = 500;
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
    if (!DRIFTING_WORKSPACE_READ_TOOLS.includes(request.name as WorkspaceReadToolName)) {
      return { ok: false, error: `Unknown workspace read tool "${request.name}"` };
    }

    try {
      const projectId = this.requireProject(request.context);
      if (request.name === 'list_files') {
        return { ok: true, data: this.listFiles(projectId, request.arguments.path) };
      }
      if (request.name === 'read_file') {
        return { ok: true, data: await this.readFile(projectId, request) };
      }
      return { ok: true, data: await this.grep(projectId, request) };
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Workspace operation failed',
      };
    }
  }

  /** Convert the public edit_file call into one certified hidden command. */
  async prepareEditRequest(
    request: AgentToolExecutionRequest,
  ): Promise<AgentToolExecutionRequest> {
    if (request.name !== DRIFTING_WORKSPACE_EDIT_TOOL) return request;
    throwIfAgentAborted(request.signal);
    const projectId = this.requireProject(request.context);
    const path = resolveWorkspacePath(projectId, request.arguments.path);
    const entry = requireWorkspaceEntry(projectId, path);
    if (!entry.writable) {
      throw new Error(`"${path}" is read-only in this version of the workspace`);
    }
    const replacements = parseReplacements(request.arguments.replacements);
    const prepared = await this.prepareWorkspaceCommand(entry, replacements, request);
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

  private listFiles(projectId: string, rawPrefix: unknown) {
    const prefix = resolveWorkspacePath(projectId, rawPrefix ?? '/');
    const entries = buildWorkspaceEntries(projectId).filter((entry) =>
      pathIsWithin(entry.path, prefix),
    );
    if (entries.length === 0) {
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

    const items = [...children.values()]
      .map((item) =>
        item.type === 'directory'
          ? {
              ...item,
              name: workspaceDirectoryDisplayName(item.path, item.descendants ?? []),
              description: describeWorkspaceDirectory(projectId, item.path, item.descendants ?? []),
            }
          : item,
      )
      .sort((left, right) => compareWorkspaceListItems(projectId, prefix, left, right));
    return {
      path: prefix,
      files: items.slice(0, MAX_LISTED_FILES).map(({ path, name, type, writable, description }) => ({
        path,
        name,
        type,
        writable,
        description,
      })),
      total: items.length,
      truncated: items.length > MAX_LISTED_FILES,
    };
  }

  private async readFile(projectId: string, request: AgentToolExecutionRequest) {
    const path = resolveWorkspacePath(projectId, request.arguments.path);
    const entry = requireWorkspaceEntry(projectId, path);
    const content = await this.renderEntry(entry, request);
    const offset = boundedInteger(request.arguments.offset, 0, 0, content.length);
    const limit = boundedInteger(
      request.arguments.limit,
      DEFAULT_READ_LIMIT,
      1,
      32_000,
    );
    const page = sliceCodePoints(content, offset, limit);
    const nextOffset = Math.min(codePointLength(content), offset + codePointLength(page));
    const totalChars = codePointLength(content);
    return {
      path,
      name: workspaceEntryDisplayName(entry),
      content: page,
      writable: entry.writable,
      offset,
      nextOffset,
      totalChars,
      truncated: nextOffset < totalChars,
    };
  }

  private async grep(projectId: string, request: AgentToolExecutionRequest) {
    const query = String(request.arguments.query ?? '').trim();
    if (!query) throw new Error('grep requires a non-empty query');
    const prefix = resolveWorkspacePath(projectId, request.arguments.path ?? '/');
    const limit = boundedInteger(request.arguments.limit, 30, 1, 100);
    const entries = buildWorkspaceEntries(projectId);
    const byEntity = new Map<string, WorkspaceEntry>();
    for (const entry of entries) {
      const key = workspaceEntityKey(entry.target);
      if (key && !byEntity.has(key) && proseLikeTarget(entry.target)) {
        byEntity.set(key, entry);
      }
    }

    const [metadataRead, proseRead] = await Promise.all([
      this.canonicalRead(request, 'search_project', { query }, 'grep-meta'),
      this.canonicalRead(request, 'search_prose', { query, limit }, 'grep-prose'),
    ]);
    const matches: Array<{ path: string; name: string; line?: number; snippet: string }> = [];
    const seen = new Set<string>();
    for (const match of recordArray(metadataRead.value, 'matches')) {
      const kind = String(match.kind ?? '');
      const title = String(match.label ?? '');
      const entry = byEntity.get(`${normalizeEntityKind(kind)}:${title}`);
      if (!entry || !pathIsWithin(entry.path, prefix)) continue;
      const key = `${entry.path}:${title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        path: entry.path,
        name: workspaceEntryDisplayName(entry),
        snippet: title,
      });
    }
    for (const match of recordArray(proseRead.value, 'matches')) {
      const kind = String(match.kind ?? '');
      const title = String(match.title ?? '');
      const entry = byEntity.get(`${normalizeEntityKind(kind)}:${title}`);
      if (!entry || !pathIsWithin(entry.path, prefix)) continue;
      const line = positiveInteger(match.block);
      const snippet = String(match.snippet ?? '');
      const key = `${entry.path}:${line ?? ''}:${snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        path: entry.path,
        name: workspaceEntryDisplayName(entry),
        ...(line ? { line } : {}),
        snippet,
      });
      if (matches.length >= limit) break;
    }
    return {
      query,
      path: prefix,
      matches: matches.slice(0, limit),
      truncated:
        matches.length > limit ||
        recordBoolean(proseRead.value, 'truncated'),
    };
  }

  private async renderEntry(
    entry: WorkspaceEntry,
    request: AgentToolExecutionRequest,
  ): Promise<string> {
    const target = entry.target;
    if (target.kind === 'overview') {
      const read = await this.canonicalRead(request, 'get_overview', {}, 'overview');
      return renderOverview(read.value, buildWorkspaceEntries(this.requireProject(request.context)));
    }
    if (target.kind === 'comments') {
      const read = await this.canonicalRead(request, 'list_comments', {}, 'comments');
      return renderComments(read.value);
    }
    if (target.kind === 'memory') {
      const read = await this.canonicalRead(request, 'list_memory', {}, 'memory');
      return renderMemories(read.value);
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
        { node: target.nodeName, prose },
        prose ? 'node-prose' : 'node-header',
      );
      if (target.kind === 'node_prose') {
        return compactProseBlocks(read.value).map((block) => block.displayText).join('\n\n');
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
      const read = await this.canonicalRead(
        request,
        'read_element',
        { element: target.elementName },
        'element',
      );
      const value = asRecord(read.value);
      switch (target.kind) {
        case 'element_body':
          return String(value.body ?? '');
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
          { node: target.storylineName, kind: 'storyline', prose: true },
          'storyline-body',
        );
        return compactProseBlocks(read.value).map((block) => block.displayText).join('\n\n');
      }
      const read = await this.canonicalRead(
        request,
        'get_storyline',
        { storyline: target.storylineName },
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
      { node: target.categoryName, kind: 'category', prose: true },
      'category',
    );
    if (target.kind === 'category_body') {
      return compactProseBlocks(read.value).map((block) => block.displayText).join('\n\n');
    }
    return String(read.value ?? '');
  }

  private async prepareWorkspaceCommand(
    entry: WorkspaceEntry,
    replacements: WorkspaceReplacement[],
    request: AgentToolExecutionRequest,
  ): Promise<{ expectedRevision: Record<string, string>; command: WorkspaceCommand }> {
    const target = entry.target;
    if (target.kind === 'node_prose') {
      const read = await this.canonicalRead(
        request,
        'read_node',
        { node: target.nodeName, prose: true },
        'edit-source',
      );
      const blocks = compactProseBlocks(read.value);
      const edits = applyProseReplacements(blocks, replacements);
      const expectedRevision = expectedRevisionFrom(read, 'node_prose', target.nodeId);
      return {
        expectedRevision,
        command: {
          name: 'edit_blocks',
          arguments: {
            entity: target.nodeName,
            kind: target.nodeKind,
            edits,
            expectedRevision,
          },
        },
      };
    }
    if (target.kind === 'node_summary' || target.kind === 'node_title') {
      const read = await this.canonicalRead(
        request,
        'read_node',
        { node: target.nodeName, prose: false },
        'edit-source',
      );
      const expectedRevision = expectedRevisionFrom(read, 'node', target.nodeId);
      const current = currentNode(target.nodeId, this.requireProject(request.context));
      const next = applyTextReplacements(
        target.kind === 'node_summary' ? current.summary : current.title,
        replacements,
      );
      return {
        expectedRevision,
        command:
          target.kind === 'node_summary'
            ? {
                name: 'set_node_summary',
                arguments: { node: current.title, summary: next, expectedRevision },
              }
            : {
                name: 'rename_node',
                arguments: { node: current.title, title: next, expectedRevision },
              },
      };
    }
    if (target.kind === 'project_facts') {
      const read = await this.canonicalRead(request, 'get_project_brief', {}, 'edit-source');
      const expectedRevision = expectedRevisionFrom(read, 'project', this.requireProject(request.context));
      const current = kvList(asRecord(read.value).facts);
      const next = parseKvFile(applyTextReplacements(prettyJson(current), replacements));
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
        { element: target.elementName },
        'edit-source',
      );
      const expectedRevision = expectedRevisionFrom(read, 'element', target.elementId);
      const value = asRecord(read.value);
      const update: Record<string, unknown> = {
        element: target.elementName,
        expectedRevision,
      };
      switch (target.kind) {
        case 'element_summary':
          update.summary = applyTextReplacements(String(value.summary ?? ''), replacements);
          break;
        case 'element_name':
          update.name = applyTextReplacements(String(value.name ?? ''), replacements);
          break;
        case 'element_aliases':
          update.aliases = parseStringArrayFile(
            applyTextReplacements(prettyJson(value.aliases ?? []), replacements),
          );
          break;
        case 'element_facts':
          update.facts = parseKvFile(
            applyTextReplacements(prettyJson(value.facts ?? []), replacements),
          );
          break;
        case 'element_group':
          update.groupName = applyTextReplacements(String(value.groupName ?? ''), replacements);
          break;
        case 'element_category':
          update.category = applyTextReplacements(String(value.category ?? ''), replacements);
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
        { storyline: target.storylineName },
        'edit-source',
      );
      const expectedRevision = expectedRevisionFrom(read, 'storyline', target.storylineId);
      const value = asRecord(read.value);
      const update: Record<string, unknown> = {
        storyline: target.storylineName,
        expectedRevision,
      };
      switch (target.kind) {
        case 'storyline_summary':
          update.summary = applyTextReplacements(String(value.summary ?? ''), replacements);
          break;
        case 'storyline_name':
          update.name = applyTextReplacements(String(value.name ?? ''), replacements);
          break;
        case 'storyline_facts': {
          const current = kvList(value.facts);
          const next = parseKvFile(
            applyTextReplacements(prettyJson(current), replacements),
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
    const existing = (await this.persistence.listToolCalls(request.sessionId)).find(
      (candidate) => candidate.id === id,
    );
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

export function workspaceCommandFromArguments(
  arguments_: unknown,
): WorkspaceCommand | null {
  const record = asRecord(arguments_);
  const raw = record[WORKSPACE_COMMAND_ARGUMENT];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const command = raw as Record<string, unknown>;
  const name = String(command.name ?? '');
  if (
    name !== 'edit_blocks' &&
    name !== 'rename_node' &&
    name !== 'set_node_summary' &&
    name !== 'update_element' &&
    name !== 'update_storyline' &&
    name !== 'update_project_facts'
  ) {
    return null;
  }
  if (!command.arguments || typeof command.arguments !== 'object' || Array.isArray(command.arguments)) {
    return null;
  }
  return {
    name,
    arguments: command.arguments as Record<string, unknown>,
  };
}

function workspaceDefinition(name: WorkspaceReadToolName): AgentToolDefinition {
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
          (right.narrativeOrder ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
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
      ? state.bookElementCategories.find((category) => category.id === categoryId)?.name ?? '未分类'
      : '未分类';
  for (const element of state.bookElements.filter((item) => item.projectId === projectId)) {
    const base = `/elements/${pathSegment(categoryName(element.categoryId))}/${pathSegment(element.name)}`;
    const shared = { elementId: element.id, elementName: element.name } as const;
    entries.push(
      {
        path: `${base}/body.md`,
        writable: false,
        description: 'Long-form element canon (read-only until body writes are certified)',
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
        writable: false,
        description: 'Long-form storyline canon (read-only until body writes are certified)',
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
        writable: false,
        description: 'Member chapters in reading order',
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

  for (const category of state.bookElementCategories.filter((item) => item.projectId === projectId)) {
    const base = `/categories/${pathSegment(category.name)}`;
    const shared = { categoryId: category.id, categoryName: category.name } as const;
    entries.push(
      {
        path: `${base}/body.md`,
        writable: false,
        description: 'Long-form category canon',
        target: { kind: 'category_body', ...shared },
      },
      {
        path: `${base}/meta.json`,
        writable: false,
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
    const duplicateSuffix = (materialTitleCounts.get(title) ?? 0) > 1 ? `~${item.id.slice(0, 8)}` : '';
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
      description: 'Author-approved standing guidance',
      target: { kind: 'memory' },
    },
  );
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
    case 'memory':
      return '长期写作指南';
  }
}

function workspaceDirectoryDisplayName(
  path: string,
  descendants: readonly WorkspaceEntry[],
): string {
  const rootNames: Record<string, string> = {
    '/chapters': '章节',
    '/drifts': '漂移灵感',
    '/elements': '故事元素',
    '/storylines': '故事线',
    '/categories': '元素分类',
    '/materials': '参考素材',
    '/project': '项目设定',
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
  const nodeTarget = descendants
    .map((entry) => entry.target)
    .find(isNodeTarget);
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

function requireWorkspaceEntry(projectId: string, path: string): WorkspaceEntry {
  const entry = buildWorkspaceEntries(projectId).find((candidate) => candidate.path === path);
  if (!entry) {
    throw new Error(`No virtual file exists at "${path}"; call list_files to refresh the workspace`);
  }
  return entry;
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
    '- `/storylines/*`: storyline canon and chapter membership',
    '- `/project/facts.json`: book-level constraints',
    '- `/materials/*`: reference material (read-only)',
    '',
    'Use list_files to browse, read_file to inspect, grep to search, and edit_file to change writable files.',
    'Internal entity ids, Yjs versions, freshness checks, sync, and review are handled by the runtime.',
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

interface WorkspaceReplacement {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

function parseReplacements(value: unknown): WorkspaceReplacement[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('edit_file requires at least one exact replacement');
  }
  return value.map((raw, index) => {
    const row = asRecord(raw);
    if (typeof row.oldText !== 'string' || row.oldText.length === 0) {
      throw new Error(`replacements[${index}].oldText must be non-empty`);
    }
    if (typeof row.newText !== 'string') {
      throw new Error(`replacements[${index}].newText must be a string`);
    }
    return {
      oldText: row.oldText,
      newText: row.newText,
      replaceAll: row.replaceAll === true,
    };
  });
}

function applyTextReplacements(content: string, replacements: readonly WorkspaceReplacement[]): string {
  let next = content;
  for (const replacement of replacements) {
    const count = countOccurrences(next, replacement.oldText);
    if (count === 0) {
      throw new Error(`oldText was not found in the current file: ${previewText(replacement.oldText)}`);
    }
    if (!replacement.replaceAll && count !== 1) {
      throw new Error(
        `oldText occurs ${count} times; include more surrounding text or set replaceAll=true`,
      );
    }
    next = replacement.replaceAll
      ? next.split(replacement.oldText).join(replacement.newText)
      : next.replace(replacement.oldText, replacement.newText);
  }
  if (next === content) throw new Error('The replacements do not change the file');
  return next;
}

function applyProseReplacements(
  blocks: readonly CompactProseBlock[],
  replacements: readonly WorkspaceReplacement[],
): Array<{ block: number; text: string }> {
  const displays = blocks.map((block) => block.displayText);
  const original = [...displays];
  for (const replacement of replacements) {
    if (replacement.oldText.includes('\n') || replacement.newText.includes('\n')) {
      throw new Error(
        'A prose replacement must stay within one paragraph. Edit paragraphs separately in the same edit_file call.',
      );
    }
    const matches: Array<{ blockIndex: number; count: number }> = [];
    let total = 0;
    displays.forEach((text, blockIndex) => {
      const count = countOccurrences(text, replacement.oldText);
      if (count > 0) matches.push({ blockIndex, count });
      total += count;
    });
    if (total === 0) {
      throw new Error(`oldText was not found in the current file: ${previewText(replacement.oldText)}`);
    }
    if (!replacement.replaceAll && total !== 1) {
      throw new Error(
        `oldText occurs ${total} times; include more surrounding text or set replaceAll=true`,
      );
    }
    for (const match of matches) {
      displays[match.blockIndex] = replacement.replaceAll
        ? displays[match.blockIndex]!.split(replacement.oldText).join(replacement.newText)
        : displays[match.blockIndex]!.replace(replacement.oldText, replacement.newText);
      if (!replacement.replaceAll) break;
    }
  }
  const edits: Array<{ block: number; text: string }> = [];
  displays.forEach((display, index) => {
    if (display === original[index]) return;
    const block = blocks[index]!;
    if (block.typePrefix && !display.startsWith(block.typePrefix)) {
      throw new Error(
        `Keep the leading ${JSON.stringify(block.typePrefix)} marker when editing this non-paragraph block`,
      );
    }
    edits.push({
      block: block.block,
      text: block.typePrefix ? display.slice(block.typePrefix.length) : display,
    });
  });
  if (edits.length === 0) throw new Error('The replacements do not change the file');
  return edits;
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
  if (text.startsWith('# ')) return '# ';
  if (text.startsWith('> ')) return '> ';
  if (text.startsWith('` ')) return '` ';
  if (text.startsWith('1. ')) return '1. ';
  if (text.startsWith('- ')) return '- ';
  const unknown = /^\[[^\]]+\] /.exec(text);
  return unknown?.[0] ?? '';
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

function proseLikeTarget(target: WorkspaceTarget): boolean {
  return (
    target.kind === 'node_prose' ||
    target.kind === 'element_body' ||
    target.kind === 'storyline_body' ||
    target.kind === 'category_body'
  );
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

function resolveWorkspacePath(projectId: string, value: unknown): string {
  const normalized = normalizeVirtualPath(value);
  if (normalized === '/') return normalized;
  const paths = new Set<string>(['/']);
  for (const entry of buildWorkspaceEntries(projectId)) {
    paths.add(entry.path);
    const segments = entry.path.split('/').filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      paths.add(`/${segments.slice(0, index).join('/')}`);
    }
  }
  if (paths.has(normalized)) return normalized;
  const suffixMatches = [...paths].filter((path) => path.endsWith(normalized));
  return suffixMatches.length === 1 ? suffixMatches[0]! : normalized;
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

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, offset);
    if (at < 0) break;
    count += 1;
    offset = at + needle.length;
  }
  return count;
}

function previewText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return JSON.stringify(compact.length > 120 ? `${compact.slice(0, 120)}…` : compact);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, offset: number, limit: number): string {
  return Array.from(value).slice(offset, offset + limit).join('');
}
