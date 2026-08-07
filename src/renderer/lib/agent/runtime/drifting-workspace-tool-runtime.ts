import { Value } from '@sinclair/typebox/value';

import { allElementNames, type BookElement } from '../../../domain/book-element';
import { isChapter } from '../../../domain/book-node';
import { extractTextFromCommentBody, type Comment } from '../../../domain/comment';
import { parseKv, type KvEntry } from '../../../domain/kv';
import { useDataStore, type EntityRelationLink } from '../../../store/data-store';
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
  normalizeAuthoredTextTransportArtifacts,
  normalizeWorkspaceProseReplacements,
  parseWorkspaceTextReplacements,
  projectAuthoredTextForModel,
  restoreAuthoredTextAnnotations,
  type WorkspaceTextReplacement,
} from './workspace-prose-file';
import { stripRedundantLeadingAuthoredTitle } from './normalize-new-authored-prose';
import { describeWorkspaceDomainTarget } from './workspace-domain-language';
import {
  DRIFTING_DOMAIN_READ_TOOLS,
  isDriftingDomainDirectWriteToolName,
  isDriftingDomainReadToolName,
  isDriftingDomainWriteToolName,
  WORKSPACE_NOOP_WRITE_MODEL_MARKER,
  isDriftingWorkspaceCommandName,
  type DriftingWorkspaceCommandName,
  type DriftingDomainReadToolName,
} from './drifting-workspace-tool-contract';

export {
  DRIFTING_DOMAIN_PROVIDER_TOOLS,
  DRIFTING_DOMAIN_READ_TOOLS,
  DRIFTING_DOMAIN_WRITE_TOOLS,
  WORKSPACE_COMPLETE_READ_MODEL_MARKER,
  WORKSPACE_NOOP_WRITE_MODEL_MARKER,
} from './drifting-workspace-tool-contract';

/**
 * Preparing a domain write can prove that the requested authored state is
 * already current. That is a successful, side-effect-free write outcome, not
 * a failed mutation for the model to debug. The outer write coordinator owns
 * this signal so no durable effect is claimed for work that never mutates.
 */
export class WorkspaceNoopWriteSignal extends Error {
  readonly result: AgentToolExecutionResult;

  constructor(path: string) {
    const target = describeWorkspaceDomainTarget(path);
    super(`${target}${WORKSPACE_NOOP_WRITE_MODEL_MARKER}`);
    this.name = 'WorkspaceNoopWriteSignal';
    this.result = {
      ok: true,
      data: { noop: true, target: path },
      modelData: `${target}${WORKSPACE_NOOP_WRITE_MODEL_MARKER}。直接继续剩余任务。`,
    };
  }
}

export function isWorkspaceNoopWriteSignal(
  error: unknown,
): error is WorkspaceNoopWriteSignal {
  return error instanceof WorkspaceNoopWriteSignal;
}

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

interface PreparedCommentTextAnchor {
  targetBlockId: string;
  anchorJson: string;
}

interface WorkspaceCommand {
  name: DriftingWorkspaceCommandName;
  arguments: Record<string, unknown>;
}

interface PreparedDomainWrite {
  path: string;
  expectedRevision: Record<string, string>;
  command: WorkspaceCommand;
  changeSummary?: string;
  remainingWork?: string;
  authoredReadState?: WorkspaceAuthoredReadState;
  skippedStale?: number;
}

interface WorkspaceReadCoverage {
  fingerprint: string;
  totalChars: number;
  ranges: Array<{ start: number; end: number }>;
  completeContent?: string;
  /** Exact canonical prose read that produced this model-visible page. */
  freshness?: ReadFreshness;
}

export interface WorkspaceAuthoredReadState {
  targetKey: string;
  target: string;
  summary: string;
  completeBodyRead: boolean;
  focusedBodyEdit: boolean;
  currentPassages: string[];
}

const DEFAULT_READ_LIMIT = 16_000;
const MAX_LISTED_FILES = 500;
const MAX_STRUCTURED_CATALOG_ITEMS = 24;
const MAX_TRACKED_READ_COVERAGE = 512;
const MAX_CACHED_COMPLETE_READS = 32;
const WORKSPACE_COMMAND_ARGUMENT = '__workspaceCommand';
const WORKSPACE_AUTHORED_READ_STATE_ARGUMENT = '__workspaceAuthoredReadState';
const DOMAIN_RUNTIME_CONTROL_TOOLS = new Set(['ask_user', 'read_tool_result']);

export function workspaceAuthoredReadStateFromArguments(
  value: unknown,
): WorkspaceAuthoredReadState | null {
  const record = asRecord(value);
  const state = asRecord(record[WORKSPACE_AUTHORED_READ_STATE_ARGUMENT]);
  return typeof state.targetKey === 'string' &&
    state.targetKey.length > 0 &&
    typeof state.target === 'string' &&
    state.target.length > 0 &&
    typeof state.summary === 'string' &&
    typeof state.completeBodyRead === 'boolean' &&
    (state.focusedBodyEdit === undefined || typeof state.focusedBodyEdit === 'boolean') &&
    (state.currentPassages === undefined ||
      (Array.isArray(state.currentPassages) &&
        state.currentPassages.every((passage) => typeof passage === 'string')))
    ? {
        targetKey: state.targetKey,
        target: state.target,
        summary: state.summary,
        completeBodyRead: state.completeBodyRead,
        focusedBodyEdit: state.focusedBodyEdit === true,
        currentPassages: Array.isArray(state.currentPassages)
          ? state.currentPassages
              .map((passage) => projectAuthoredTextForModel(passage).text)
              .slice(0, 12)
          : [],
      }
    : null;
}

interface WorkspaceListItem {
  path: string;
  name: string;
  type: 'directory' | 'file';
  writable: boolean;
  description: string;
  aliases?: string[];
  descendants?: WorkspaceEntry[];
}

export interface DriftingWorkspaceToolRuntimeOptions {
  readRuntime: AgentToolRuntime;
  getContext?: () => AgentToolContext | null;
  persistence?: AgentRuntimePersistenceRepository;
  now?: () => string;
}

/**
 * Provider-facing domain tools over Drifting's structured authoring model.
 * Reads still flow through certified Drifting reads (and therefore live Yjs);
 * writes become hidden domain commands with runtime-owned freshness evidence.
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
    const controls = this.readRuntime
      .listDefinitions(context)
      .filter((definition) => DOMAIN_RUNTIME_CONTROL_TOOLS.has(definition.name));
    return [...DRIFTING_DOMAIN_READ_TOOLS.map((name) => domainDefinition(name)), ...controls];
  }

  async execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult> {
    throwIfAgentAborted(request.signal);
    if (request.access !== 'read') {
      return {
        ok: false,
        error: `Domain read runtime denied write tool "${request.name}"`,
      };
    }
    if (DOMAIN_RUNTIME_CONTROL_TOOLS.has(request.name)) {
      return this.readRuntime.execute(request);
    }
    if (!isDriftingDomainReadToolName(request.name)) {
      return { ok: false, error: `Unknown domain read tool "${request.name}"` };
    }

    try {
      const projectId = this.requireProject(request.context);
      const args = request.arguments;
      let data: unknown;
      switch (request.name) {
        case 'get_project_overview':
          data = (await this.canonicalRead(request, 'get_overview', {}, 'project-overview')).value;
          break;
        case 'get_project_facts':
          data = await this.readFile(projectId, domainReadFileRequest(request, '/project/facts.json'));
          break;
        case 'list_chapters':
          data = await this.listFiles(projectId, '/chapters', request);
          break;
        case 'read_chapter':
          data = await this.readFile(
            projectId,
            domainReadFileRequest(
              request,
              `/chapters/${pathSegment(requiredDomainName(args.chapter, 'chapter'))}/prose.md`,
            ),
          );
          break;
        case 'list_inspirations':
          data = await this.listFiles(projectId, '/drifts', request);
          break;
        case 'read_inspiration':
          data = await this.readFile(
            projectId,
            domainReadFileRequest(
              request,
              `/drifts/${pathSegment(requiredDomainName(args.inspiration, 'inspiration'))}/prose.md`,
            ),
          );
          break;
        case 'list_element_categories':
          data = await this.listFiles(projectId, '/categories', request);
          break;
        case 'read_element_category':
          data = await this.readFile(
            projectId,
            domainReadFileRequest(
              request,
              `/categories/${pathSegment(requiredDomainName(args.category, 'category'))}/body.md`,
            ),
          );
          break;
        case 'find_element_appearances':
          data = (
            await this.canonicalRead(
              request,
              'where_does_entity_appear',
              { kind: 'element', name: requiredDomainName(args.element, 'element') },
              'element-appearances',
            )
          ).value;
          break;
        case 'list_storylines':
          data = await this.listFiles(projectId, '/storylines', request);
          break;
        case 'read_storyline':
          data = await this.readFile(
            projectId,
            domainReadFileRequest(
              request,
              `/storylines/${pathSegment(requiredDomainName(args.storyline, 'storyline'))}/body.md`,
            ),
          );
          break;
        case 'list_relations':
          data = await this.listFiles(projectId, '/relations', request);
          break;
        case 'list_entity_relations':
          data = (
            await this.canonicalRead(
              request,
              'get_entity_relations',
              {
                kind: relationKindForDomainType(args.entityType),
                name: requiredDomainName(args.entity, 'entity'),
              },
              'entity-relations',
            )
          ).value;
          break;
        case 'list_comments': {
          const targetType = optionalDomainText(args.targetType);
          const targetName = optionalDomainText(args.targetName);
          if (Boolean(targetType) !== Boolean(targetName)) {
            throw new Error('targetType and targetName must be provided together');
          }
          data = (
            await this.canonicalRead(
              request,
              'list_comments',
              {
                ...(targetType && targetName
                  ? {
                      kind: relationKindForDomainType(targetType),
                      entity: requiredDomainName(targetName, 'targetName'),
                    }
                  : {}),
                ...(args.status !== undefined ? { status: args.status } : {}),
                ...(args.onlyTodos !== undefined ? { onlyTodos: args.onlyTodos } : {}),
              },
              'comments',
            )
          ).value;
          break;
        }
        case 'list_author_rules':
          data = await this.listFiles(projectId, '/memory', request);
          break;
        default:
          return this.readRuntime.execute(request);
      }
      return { ok: true, data, modelData: workspaceReadModelData(data) };
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      return {
        ok: false,
        error: publicDomainReadError(error),
      };
    }
  }

  /** Convert a simple public domain mutation into one certified hidden command. */
  async prepareWriteRequest(
    request: AgentToolExecutionRequest,
  ): Promise<AgentToolExecutionRequest> {
    if (!isDriftingDomainWriteToolName(request.name)) return request;
    throwIfAgentAborted(request.signal);
    const projectId = this.requireProject(request.context);
    return isDriftingDomainDirectWriteToolName(request.name)
      ? this.prepareDirectDomainWrite(request, projectId)
      : this.prepareWrappedDomainWrite(request, projectId);
  }

  private async prepareDirectDomainWrite(
    request: AgentToolExecutionRequest,
    projectId: string,
  ): Promise<AgentToolExecutionRequest> {
    const args = request.arguments;
    let path: string;
    let expectedRevision: Record<string, string>;
    let commandArguments: Record<string, unknown> = { ...args };

    switch (request.name) {
      case 'create_element': {
        const category = requiredDomainName(args.category, 'category');
        const name = requiredDomainName(args.name, 'element');
        path = `/elements/${pathSegment(category)}/${pathSegment(name)}/body.md`;
        const prepared = await this.prepareCreateCommand(
          path,
          normalizeDomainBody(args.body),
          request,
          optionalDomainText(args.summary),
        );
        expectedRevision = prepared.expectedRevision;
        commandArguments = {
          ...prepared.command.arguments,
          ...(Array.isArray(args.aliases) ? { aliases: args.aliases } : {}),
          ...(args.groupName !== undefined ? { groupName: args.groupName } : {}),
          ...(Array.isArray(args.facts) ? { facts: args.facts } : {}),
        };
        break;
      }
      case 'update_element': {
        const entry = requireDomainBodyEntry(
          projectId,
          'element',
          requiredDomainName(args.element, 'element'),
        );
        if (entry.target.kind !== 'element_body') throw new Error('The element target is invalid');
        const read = await this.canonicalRead(
          request,
          'read_element',
          { element: entry.target.elementId },
          'update-element',
        );
        path = entry.path;
        expectedRevision = expectedRevisionFrom(read, 'element', entry.target.elementId);
        commandArguments = {
          ...args,
          element: entry.target.elementId,
          expectedRevision,
        };
        break;
      }
      case 'delete_element': {
        path = resolveWorkspaceCompleteObjectPath(
          projectId,
          `要素「${requiredDomainName(args.element, 'element')}」`,
        );
        const prepared = await this.prepareDeleteCommand(path, request);
        expectedRevision = prepared.expectedRevision;
        commandArguments = prepared.command.arguments;
        break;
      }
      case 'create_storyline': {
        const name = requiredDomainName(args.name, 'storyline');
        path = `/storylines/${pathSegment(name)}/body.md`;
        const prepared = await this.prepareCreateCommand(
          path,
          normalizeDomainBody(args.body),
          request,
          optionalDomainText(args.summary),
        );
        expectedRevision = prepared.expectedRevision;
        commandArguments = prepared.command.arguments;
        break;
      }
      case 'update_storyline': {
        const entry = requireDomainBodyEntry(
          projectId,
          'storyline',
          requiredDomainName(args.storyline, 'storyline'),
        );
        if (entry.target.kind !== 'storyline_body') {
          throw new Error('The storyline target is invalid');
        }
        const read = await this.canonicalRead(
          request,
          'get_storyline',
          { storyline: entry.target.storylineId },
          'update-storyline',
        );
        path = entry.path;
        expectedRevision = expectedRevisionFrom(read, 'storyline', entry.target.storylineId);
        commandArguments = {
          ...args,
          storyline: entry.target.storylineId,
          expectedRevision,
        };
        break;
      }
      case 'create_comment': {
        const read = await this.canonicalRead(request, 'get_project_brief', {}, 'create-comment');
        expectedRevision = expectedRevisionFrom(read, 'project', projectId);
        path = `/comments/new-${pathSegment(request.idempotencyKey)}.json`;
        const hasTargetType = args.targetType !== undefined;
        const hasTargetName = args.targetName !== undefined;
        if (hasTargetType !== hasTargetName) {
          throw new Error('targetType and targetName must be provided together');
        }
        const targetText = optionalDomainText(args.targetText);
        if (targetText && !hasTargetType) {
          throw new Error('targetText requires targetType and targetName');
        }
        const preparedAnchor = targetText
          ? await this.prepareCommentTextAnchor(
              projectId,
              requiredDomainName(args.targetType, 'targetType'),
              requiredDomainName(args.targetName, 'targetName'),
              targetText,
              request,
            )
          : null;
        // Internal compatibility for already-prepared callers. The public
        // create_comment schema exposes targetText, not this storage handle.
        const legacyTargetBlockId = optionalDomainText(args.targetBlockId);
        commandArguments = {
          body: args.body,
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          ...(hasTargetType
            ? {
                targetKind: relationKindForDomainType(args.targetType),
                target: requiredDomainName(args.targetName, 'targetName'),
              }
            : {}),
          ...(preparedAnchor ??
            (legacyTargetBlockId ? { targetBlockId: legacyTargetBlockId } : {})),
          expectedRevision,
        };
        break;
      }
      case 'delete_comment': {
        const commentId = requiredDomainName(args.commentId, 'commentId');
        const read = await this.canonicalRead(request, 'list_comments', {}, 'delete-comment');
        expectedRevision = expectedRevisionFrom(read, 'comment', commentId);
        path = `/comments/${pathSegment(commentId)}.json`;
        commandArguments = { commentId, expectedRevision };
        break;
      }
      case 'update_project_facts': {
        const fields = factsRecord(args.facts);
        const prepared = await this.prepareProjectFactAttributes(fields, request);
        path = '/project/facts.json';
        expectedRevision = prepared.expectedRevision;
        commandArguments = prepared.command.arguments;
        break;
      }
      case 'create_element_patch':
      case 'update_element_patch':
      case 'delete_element_patch': {
        const elementName = requiredDomainName(args.element, 'element');
        const elementEntry = requireDomainBodyEntry(projectId, 'element', elementName);
        if (elementEntry.target.kind !== 'element_body') {
          throw new Error('The element target is invalid');
        }
        const read = await this.canonicalRead(
          request,
          'get_element_patches',
          { element: elementEntry.target.elementId },
          `${request.name}-freshness`,
        );
        const entityKind =
          request.name === 'create_element_patch' ? 'element_patch_set' : 'element_patch';
        const entityId =
          request.name === 'create_element_patch'
            ? elementEntry.target.elementId
            : requiredDomainName(args.patchId, 'patchId');
        expectedRevision = expectedRevisionFrom(read, entityKind, entityId);
        path =
          request.name === 'create_element_patch'
            ? `${elementEntry.path}#patches`
            : `${elementEntry.path}#patch:${entityId}`;
        commandArguments = {
          ...args,
          element: elementEntry.target.elementId,
          expectedRevision,
        };
        break;
      }
      default:
        throw new Error(`Unsupported direct domain write "${request.name}"`);
    }

    return {
      ...request,
      arguments: { ...commandArguments, path, expectedRevision },
    };
  }

  private async prepareWrappedDomainWrite(
    request: AgentToolExecutionRequest,
    projectId: string,
  ): Promise<AgentToolExecutionRequest> {
    const args = request.arguments;
    let prepared: PreparedDomainWrite;

    switch (request.name) {
      case 'create_chapter':
      case 'create_inspiration': {
        const title = requiredDomainName(args.title, 'title');
        const path = `/${request.name === 'create_chapter' ? 'chapters' : 'drifts'}/${pathSegment(title)}/prose.md`;
        const created = await this.prepareCreateCommand(
          path,
          normalizeDomainBody(args.body),
          request,
          optionalDomainText(args.summary),
        );
        prepared = { path, ...created };
        break;
      }
      case 'rename_chapter':
      case 'rename_inspiration': {
        const isChapter = request.name === 'rename_chapter';
        const name = requiredDomainName(
          isChapter ? args.chapter : args.inspiration,
          isChapter ? 'chapter' : 'inspiration',
        );
        const path = `/${isChapter ? 'chapters' : 'drifts'}/${pathSegment(name)}/title.txt`;
        prepared = await this.prepareExistingWholeFile(
          projectId,
          path,
          requiredDomainName(args.title, 'title'),
          request,
        );
        break;
      }
      case 'set_chapter_summary':
      case 'set_inspiration_summary': {
        const isChapter = request.name === 'set_chapter_summary';
        const name = requiredDomainName(
          isChapter ? args.chapter : args.inspiration,
          isChapter ? 'chapter' : 'inspiration',
        );
        const path = `/${isChapter ? 'chapters' : 'drifts'}/${pathSegment(name)}/summary.md`;
        prepared = await this.prepareExistingWholeFile(
          projectId,
          path,
          String(args.summary ?? ''),
          request,
        );
        break;
      }
      case 'revise_chapter':
      case 'revise_inspiration':
      case 'revise_element':
      case 'revise_storyline': {
        const path = domainProsePath(projectId, request.name, args);
        prepared = await this.prepareExistingRevision(projectId, path, args.changes, request);
        break;
      }
      case 'replace_chapter_body':
      case 'replace_inspiration_body':
      case 'replace_element_body':
      case 'replace_storyline_body':
      case 'replace_element_category_body': {
        const path = domainProsePath(projectId, request.name, args);
        prepared = await this.prepareExistingWholeFile(
          projectId,
          path,
          normalizeDomainBody(args.body),
          request,
          request.name === 'replace_chapter_body' ? optionalDomainText(args.summary) : undefined,
        );
        break;
      }
      case 'delete_chapter':
      case 'delete_inspiration':
      case 'delete_storyline':
      case 'delete_element_category': {
        const path = domainCompleteObjectPath(projectId, request.name, args);
        const deleted = await this.prepareDeleteCommand(path, request);
        prepared = { path, ...deleted };
        break;
      }
      case 'create_element_category': {
        const name = requiredDomainName(args.name, 'category');
        const path = `/categories/${pathSegment(name)}/body.md`;
        const created = await this.prepareCreateCommand(
          path,
          normalizeDomainBody(args.body),
          request,
        );
        prepared = { path, ...created };
        break;
      }
      case 'update_element_category': {
        const category = requiredDomainName(args.category, 'category');
        const path = `/categories/${pathSegment(category)}/meta.json`;
        const content = prettyJson({
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.templateFacts !== undefined ? { templateFacts: args.templateFacts } : {}),
        });
        prepared = await this.prepareExistingWholeFile(projectId, path, content, request);
        break;
      }
      case 'add_chapter_to_storyline':
      case 'remove_chapter_from_storyline':
      case 'set_chapter_primary_storyline':
      case 'replace_storyline_chapters':
        prepared = await this.prepareStorylineMembershipDomainWrite(request, projectId);
        break;
      case 'create_relation': {
        const fromType = relationKindForDomainType(args.fromType);
        const toType = relationKindForDomainType(args.toType);
        assertDomainRelationEndpoint(projectId, args.fromType, args.fromName);
        assertDomainRelationEndpoint(projectId, args.toType, args.toName);
        const read = await this.canonicalRead(request, 'get_project_brief', {}, 'create-relation');
        const expectedRevision = expectedRevisionFrom(read, 'project', projectId);
        const path = `/relations/new-${pathSegment(request.idempotencyKey)}.json`;
        prepared = {
          path,
          expectedRevision,
          command: {
            name: 'add_relation',
            arguments: {
              fromKind: fromType,
              from: requiredDomainName(args.fromName, 'fromName'),
              toKind: toType,
              to: requiredDomainName(args.toName, 'toName'),
              ...(args.relationType !== undefined ? { kind: args.relationType } : {}),
              expectedRevision,
            },
          },
        };
        break;
      }
      case 'update_relation': {
        const relationId = requiredDomainName(args.relationId, 'relationId');
        const path = `/relations/${pathSegment(relationId)}.json`;
        prepared = await this.prepareExistingWholeFile(
          projectId,
          path,
          prettyJson({ kind: String(args.relationType ?? '') }),
          request,
        );
        break;
      }
      case 'delete_relation': {
        const relationId = requiredDomainName(args.relationId, 'relationId');
        const path = `/relations/${pathSegment(relationId)}.json`;
        const deleted = await this.prepareDeleteCommand(path, request);
        prepared = { path, ...deleted };
        break;
      }
      case 'update_comment': {
        const commentId = requiredDomainName(args.commentId, 'commentId');
        const read = await this.canonicalRead(request, 'list_comments', {}, 'update-comment');
        const expectedRevision = expectedRevisionFrom(read, 'comment', commentId);
        const path = `/comments/${pathSegment(commentId)}.json`;
        prepared = {
          path,
          expectedRevision,
          command: {
            name: 'update_comment',
            arguments: { ...args, commentId, expectedRevision },
          },
        };
        break;
      }
      case 'create_author_rule': {
        const read = await this.canonicalRead(request, 'list_memory', {}, 'create-author-rule');
        const expectedRevision = expectedRevisionFrom(read, 'memory_set', projectId);
        const path = `/memory/new-${pathSegment(request.idempotencyKey)}.json`;
        prepared = {
          path,
          expectedRevision,
          command: { name: 'remember', arguments: { ...args, expectedRevision } },
        };
        break;
      }
      case 'update_author_rule':
      case 'delete_author_rule': {
        const ruleId = requiredDomainName(args.ruleId, 'ruleId');
        const read = await this.canonicalRead(request, 'list_memory', {}, `${request.name}-read`);
        const expectedRevision = expectedRevisionFrom(read, 'memory', ruleId);
        const currentRule = recordArray(read.value, 'memories').find(
          (candidate) => String(candidate.memoryId ?? '') === ruleId,
        );
        if (!currentRule) throw new Error(`No author rule "${ruleId}" exists in this project`);
        const path = `/memory/${pathSegment(ruleId)}.json`;
        prepared = {
          path,
          expectedRevision,
          command:
            request.name === 'delete_author_rule'
              ? { name: 'forget', arguments: { memoryId: ruleId, expectedRevision } }
              : {
                  name: 'update_memory',
                  arguments: {
                    memoryId: ruleId,
                    kind: args.kind ?? currentRule.kind,
                    body: args.body ?? currentRule.body,
                    ...(currentRule.targetKind !== undefined
                      ? { targetKind: currentRule.targetKind }
                      : {}),
                    ...(currentRule.target !== undefined ? { target: currentRule.target } : {}),
                    ...(currentRule.targetBlockId !== undefined
                      ? { targetBlockId: currentRule.targetBlockId }
                      : {}),
                    ...(currentRule.supersedesId !== undefined
                      ? { supersedesId: currentRule.supersedesId }
                      : {}),
                    expectedRevision,
                  },
                },
        };
        break;
      }
      default:
        throw new Error(`Unsupported wrapped domain write "${request.name}"`);
    }

    return this.wrapDomainCommand(request, prepared);
  }

  private async prepareExistingWholeFile(
    projectId: string,
    path: string,
    content: string,
    request: AgentToolExecutionRequest,
    summary?: string,
  ): Promise<PreparedDomainWrite> {
    const entry = requireWorkspaceFileEntry(projectId, path, true);
    try {
      const prepared = await this.prepareWholeFileCommand(entry, content, request, summary);
      this.invalidateReadCoverage(request, entry.path);
      return { path: entry.path, ...prepared };
    } catch (error) {
      if (isWorkspaceNoopPreparationError(error)) {
        throw new WorkspaceNoopWriteSignal(entry.path);
      }
      throw error;
    }
  }

  private async prepareExistingRevision(
    projectId: string,
    path: string,
    rawChanges: unknown,
    request: AgentToolExecutionRequest,
  ): Promise<PreparedDomainWrite> {
    const requestedEntry = requireWorkspaceFileEntry(projectId, path, true);
    const replacements = parseWorkspaceDomainChanges(rawChanges);
    const entry = this.resolveUniqueReadProseEditTarget(requestedEntry, replacements, request);
    try {
      const prepared = await this.prepareWorkspaceCommand(entry, replacements, request);
      this.invalidateReadCoverage(request, entry.path);
      return { path: entry.path, ...prepared };
    } catch (error) {
      if (isWorkspaceNoopPreparationError(error)) {
        throw new WorkspaceNoopWriteSignal(entry.path);
      }
      throw error;
    }
  }

  private async prepareCommentTextAnchor(
    projectId: string,
    targetType: string,
    targetName: string,
    targetText: string,
    request: AgentToolExecutionRequest,
  ): Promise<PreparedCommentTextAnchor> {
    const entry = domainCommentProseEntry(projectId, targetType, targetName);
    const target = workspaceProseTarget(entry.target);
    if (!target) {
      throw new Error('The requested comment target has no prose body');
    }
    const kind = target.entityType === 'node' ? target.nodeKind : target.entityType;
    const read = await this.canonicalRead(
      request,
      'read_node',
      { node: target.id, kind, prose: true },
      'comment-anchor-prose',
    );
    const occurrences = compactProseBlocks(read.value).flatMap((block) => {
      const offsets: number[] = [];
      let cursor = 0;
      while (cursor <= block.rawText.length - targetText.length) {
        const offset = block.rawText.indexOf(targetText, cursor);
        if (offset < 0) break;
        offsets.push(offset);
        cursor = offset + Math.max(1, targetText.length);
      }
      return offsets.map((offset) => ({ block, offset }));
    });
    if (occurrences.length !== 1) {
      throw new Error(
        occurrences.length === 0
          ? 'targetText was not found in the current live prose'
          : `targetText matched ${occurrences.length} places; provide a longer unique excerpt`,
      );
    }
    const occurrence = occurrences[0]!;
    const lookup = await this.canonicalRead(
      request,
      'lookup_block',
      { node: target.id, kind, ordinal: occurrence.block.block },
      'comment-anchor-block-id',
    );
    const match = recordArray(lookup.value, 'matches').find(
      (candidate) => Number(candidate.block) === occurrence.block.block,
    );
    const targetBlockId = optionalDomainText(match?.blockId);
    if (!targetBlockId) {
      throw new Error(
        'The matched prose block has no stable blockId yet; open this entity once and retry',
      );
    }
    // Re-read the resolved stable handle from live Yjs. If prose changed during
    // preparation, fail closed instead of creating a comment on the wrong block.
    const live = await this.canonicalRead(
      request,
      'read_block',
      { node: target.id, kind, blockId: targetBlockId },
      'comment-anchor-live-block',
    );
    const liveBlock = asRecord(live.value);
    const blockText = typeof liveBlock.text === 'string' ? liveBlock.text : '';
    const liveOffset = blockText.indexOf(targetText);
    if (liveBlock.found !== true || liveOffset < 0 || blockText.indexOf(targetText, liveOffset + 1) >= 0) {
      throw new Error('The target prose changed while the comment anchor was being prepared; retry');
    }
    return {
      targetBlockId,
      anchorJson: JSON.stringify({
        selectedText: targetText,
        blockText,
        blockSelectionFrom: liveOffset,
        blockSelectionTo: liveOffset + targetText.length,
        blockSnapshots: [{ blockId: targetBlockId, blockText }],
        textAnchor: {
          startBlockId: targetBlockId,
          startOffset: liveOffset,
          endBlockId: targetBlockId,
          endOffset: liveOffset + targetText.length,
          text: targetText,
        },
      }),
    };
  }

  private async prepareStorylineMembershipDomainWrite(
    request: AgentToolExecutionRequest,
    projectId: string,
  ): Promise<PreparedDomainWrite> {
    const storylineName = requiredDomainName(request.arguments.storyline, 'storyline');
    const entry = requireDomainBodyEntry(projectId, 'storyline', storylineName);
    if (entry.target.kind !== 'storyline_body') {
      throw new Error('The storyline target is invalid');
    }
    const read = await this.canonicalRead(
      request,
      'get_storyline',
      { storyline: entry.target.storylineId },
      'storyline-membership',
    );
    const expectedRevision = expectedRevisionFrom(
      read,
      'storyline_membership',
      entry.target.storylineId,
    );
    const current = recordArray(asRecord(read.value), 'chapters').map((row) => ({
      chapter: requiredDomainName(row.title, 'chapter'),
      isPrimary: row.isPrimary === true,
    }));
    const requestedChapter =
      request.name === 'replace_storyline_chapters'
        ? null
        : requiredDomainName(request.arguments.chapter, 'chapter');
    let chapters: Array<{ chapter: string; isPrimary: boolean }>;
    if (request.name === 'replace_storyline_chapters') {
      const primaryByName = new Map(current.map((row) => [row.chapter, row.isPrimary]));
      chapters = stringList(request.arguments.chapters, 'chapters').map((chapter) => ({
        chapter,
        isPrimary: primaryByName.get(chapter) === true,
      }));
    } else if (request.name === 'add_chapter_to_storyline') {
      chapters = current.some((row) => authoredNamesEqual(row.chapter, requestedChapter!))
        ? current
        : [...current, { chapter: requestedChapter!, isPrimary: false }];
    } else if (request.name === 'remove_chapter_from_storyline') {
      chapters = current.filter((row) => !authoredNamesEqual(row.chapter, requestedChapter!));
    } else {
      chapters = current.map((row) => ({
        ...row,
        isPrimary: authoredNamesEqual(row.chapter, requestedChapter!),
      }));
      if (!chapters.some((row) => authoredNamesEqual(row.chapter, requestedChapter!))) {
        chapters.push({ chapter: requestedChapter!, isPrimary: true });
      }
    }
    if (canonicalAgentRuntimeJson(chapters) === canonicalAgentRuntimeJson(current)) {
      throw new WorkspaceNoopWriteSignal(
        `/storylines/${pathSegment(storylineName)}/chapters.json`,
      );
    }
    const path = `/storylines/${pathSegment(storylineName)}/chapters.json`;
    return {
      path,
      expectedRevision,
      command: {
        name: 'set_storyline_membership',
        arguments: {
          storyline: entry.target.storylineId,
          chapters,
          expectedRevision,
        },
      },
    };
  }

  private wrapDomainCommand(
    request: AgentToolExecutionRequest,
    prepared: PreparedDomainWrite,
  ): AgentToolExecutionRequest {
    return {
      ...request,
      arguments: {
        path: prepared.path,
        expectedRevision: prepared.expectedRevision,
        ...(prepared.changeSummary ? { changeSummary: prepared.changeSummary } : {}),
        ...(prepared.remainingWork ? { remainingWork: prepared.remainingWork } : {}),
        ...(prepared.skippedStale
          ? { skippedStaleReplacements: prepared.skippedStale }
          : {}),
        ...(prepared.authoredReadState
          ? { [WORKSPACE_AUTHORED_READ_STATE_ARGUMENT]: prepared.authoredReadState }
          : {}),
        [WORKSPACE_COMMAND_ARGUMENT]: prepared.command,
      },
    };
  }

  private async prepareProjectFactAttributes(
    fields: Readonly<Record<string, string>>,
    request: AgentToolExecutionRequest,
  ): Promise<{
    expectedRevision: Record<string, string>;
    command: WorkspaceCommand;
    changeSummary: string;
  }> {
    if (Object.keys(fields).length === 0) {
      throw new Error('项目事实至少需要一个名称和内容。');
    }
    const read = await this.canonicalRead(request, 'get_project_brief', {}, 'write-facts');
    const expectedRevision = expectedRevisionFrom(
      read,
      'project',
      this.requireProject(request.context),
    );
    const current = new Map(
      kvList(asRecord(read.value).facts).map((fact) => [fact.key, fact.value]),
    );
    const changed = Object.entries(fields)
      .filter(([key, value]) => current.get(key) !== value)
      .map(([key, value]) => ({ key, value }));
    if (changed.length === 0) {
      throw new Error('The requested replacements do not change the file');
    }
    return {
      expectedRevision,
      changeSummary: '已更新项目事实',
      command: {
        name: 'update_project_facts',
        arguments: { facts: changed, expectedRevision },
      },
    };
  }

  private async listFiles(
    projectId: string,
    rawPrefix: unknown,
    request: AgentToolExecutionRequest,
  ) {
    const prefix = resolveWorkspaceBrowseTarget(projectId, rawPrefix ?? '/');
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
        creationGuide: workspaceDomainCreationHint(prefix),
      };
    }
    if (entries.length === 0 && isVirtualWorkspaceRoot(prefix) && prefix !== '/elements') {
      return {
        path: prefix,
        files: [],
        total: 0,
        truncated: false,
        creationGuide: workspaceDomainCreationHint(prefix),
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
          aliases: workspaceElementAliases(entry),
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
          aliases: workspaceElementAliases(entry),
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
          description: '空要素分类，可直接在此分类下新建要素。',
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
              aliases: workspaceDirectoryElementAliases(
                item.path,
                item.descendants ?? [],
              ),
            }
          : item,
      )
      .sort((left, right) => compareWorkspaceListItems(projectId, prefix, left, right));
    const listedLimit =
      prefix === '/comments' || prefix === '/relations'
        ? MAX_STRUCTURED_CATALOG_ITEMS
        : MAX_LISTED_FILES;
    return {
      path: prefix,
      files: items
        .slice(0, listedLimit)
        .map(({ path, name, type, writable, description, aliases }) => ({
          path,
          name,
          type,
          writable,
          description,
          ...(aliases && aliases.length > 0 ? { aliases } : {}),
        })),
      total: items.length,
      truncated: items.length > listedLimit,
      creationGuide: workspaceDomainCreationHint(prefix),
    };
  }

  private async readFile(projectId: string, request: AgentToolExecutionRequest) {
    const resolved = resolveWorkspacePath(projectId, request.arguments.path);
    const direct =
      findWorkspaceEntry(projectId, resolved) ??
      (await this.resolveDynamicMemoryEntry(projectId, resolved, request));
    if (!direct && (resolved === '/' || isVirtualWorkspaceRoot(resolved))) {
      // Opening a named domain collection is a perfectly natural author
      // action. Adapt it to a browse operation instead of making the model
      // reason about the list_files/read_file distinction.
      return this.listFiles(projectId, resolved, request);
    }
    const entry = direct ?? primaryWorkspaceEntry(projectId, resolved);
    if (!entry) {
      const missing = missingAuthoredTargetMessage(
        projectId,
        request.arguments.path,
      );
      if (missing) {
        const missingMessage = await this.enrichMissingAuthoredTarget(
          projectId,
          request.arguments.path,
          missing,
          request,
        );
        const path =
          semanticAuthoredCreationPath(
            projectId,
            normalizeVirtualPath(request.arguments.path),
          ) ?? resolved;
        return {
          path,
          name: describeWorkspaceDomainTarget(path),
          content: '',
          writable: true,
          offset: 0,
          nextOffset: 0,
          totalChars: 0,
          truncated: false,
          wordCount: 0,
          summary: '',
          missing: true,
          missingMessage,
        };
      }
      return this.listFiles(projectId, resolved, request);
    }
    const path = entry.path;
    let proseFreshness: ReadFreshness | null = null;
    const content = await this.renderEntry(entry, request, (read) => {
      proseFreshness = read.freshness;
    });
    const offset = boundedInteger(request.arguments.offset, 0, 0, content.length);
    const limit = boundedInteger(request.arguments.limit, DEFAULT_READ_LIMIT, 1, 32_000);
    const page = sliceCodePoints(content, offset, limit);
    const nextOffset = Math.min(codePointLength(content), offset + codePointLength(page));
    const totalChars = codePointLength(content);
    await this.recordReadCoverage(
      request,
      path,
      content,
      offset,
      nextOffset,
      totalChars,
      proseFreshness,
    );
    // A node's stored wordCount is only a projection and old imported drafts
    // can legitimately have an empty Yjs truth plus a stale non-zero counter.
    // Once this call has paid to read the live body, report the live count so
    // the model never sees contradictory "1057 words + empty file" evidence.
    const wordCount = entry.target.kind === 'node_prose' ? countWords(content) : null;
    const summary = authoredObjectSummary(entry, projectId);
    if (summary !== null) {
      // A chapter/灵感 read presents the complete current summary alongside
      // every prose page. Record that authored field as read as well, so a
      // later summary rewrite does not force the model to open the same text
      // through a second product alias merely to satisfy write safety.
      const summaryPath = path.replace(/\/(?:prose|body)\.md$/u, '/summary.md');
      const summaryChars = codePointLength(summary);
      await this.recordReadCoverage(
        request,
        summaryPath,
        summary,
        0,
        summaryChars,
        summaryChars,
      );
    }
    const relatedContext =
      entry.target.kind === 'element_body'
        ? await this.elementRelatedContext(projectId, entry, request)
        : null;
    return {
      path,
      name: workspaceEntryDisplayName(entry),
      ...(workspaceElementAliases(entry).length > 0
        ? { aliases: workspaceElementAliases(entry) }
        : {}),
      content: page,
      writable: entry.writable,
      offset,
      nextOffset,
      totalChars,
      truncated: nextOffset < totalChars,
      ...(wordCount !== null ? { wordCount } : {}),
      ...(summary !== null ? { summary } : {}),
      ...(relatedContext ? { relatedContext } : {}),
    };
  }

  private async elementRelatedContext(
    projectId: string,
    entry: WorkspaceEntry,
    request: AgentToolExecutionRequest,
  ): Promise<{
    subject: string;
    query: string;
    excerpts: Array<{ target: string; block?: number; excerpt: string }>;
    directRelations: string[];
    relatedNotes: Array<{ target: string; excerpt: string }>;
  } | null> {
    if (entry.target.kind !== 'element_body') return null;
    const target = entry.target;
    const state = useDataStore.getState();
    const element = state.bookElements.find(
      (candidate) =>
        candidate.projectId === projectId && candidate.id === target.elementId,
    );
    if (!element) return null;
    const query =
      [...element.aliases, element.name].find(
        (candidate) => /\p{Script=Han}/u.test(candidate) && candidate.trim().length >= 2,
      ) ?? element.name;
    const directRelations = [
      ...new Set(
        state.entityRelations
          .filter(
            (relation) =>
              relation.projectId === projectId &&
              (relation.fromId === element.id || relation.toId === element.id),
          )
          .map(
            (relation) =>
              `实体关系「${relation.id}」：${describeRelationForAuthor(state, relation)}`,
          ),
      ),
    ];
    const excerpts: Array<{ target: string; block?: number; excerpt: string }> = [];
    const relatedNotes: Array<{ target: string; excerpt: string }> = [];
    try {
      const searched = await this.grep(projectId, {
        ...request,
        name: 'find_element_appearances',
        arguments: { query, path: '/', limit: 24 },
        access: 'read',
      });
      const seenTargets = new Set<string>();
      for (const raw of recordArray(searched, 'matches')) {
        const path = typeof raw.path === 'string' ? raw.path : '';
        if (!/^\/(?:chapters|drifts)\//u.test(path)) continue;
        const target = describeWorkspaceDomainTarget(path);
        if (seenTargets.has(target)) continue;
        const excerpt =
          typeof raw.snippet === 'string'
            ? sliceCodePoints(projectAuthoredTextForModel(raw.snippet).text, 0, 700)
            : '';
        if (!excerpt) continue;
        seenTargets.add(target);
        const block = positiveInteger(raw.line);
        excerpts.push({ target, ...(block ? { block } : {}), excerpt });
        if (excerpts.length >= 8) break;
      }
    } catch {
      // The element itself remains readable when optional cross-work evidence
      // is unavailable; the provider can still call the explicit search tools.
    }
    try {
      const searchedNotes = await this.grep(projectId, {
        ...request,
        name: 'find_element_appearances',
        arguments: { query, path: '/comments', limit: 6 },
        access: 'read',
      });
      const seenNotes = new Set<string>();
      for (const raw of recordArray(searchedNotes, 'matches')) {
        const path = typeof raw.path === 'string' ? raw.path : '';
        if (!/^\/comments\//u.test(path) || seenNotes.has(path)) continue;
        const excerpt =
          typeof raw.snippet === 'string'
            ? sliceCodePoints(projectAuthoredTextForModel(raw.snippet).text, 0, 320)
            : '';
        if (!excerpt) continue;
        seenNotes.add(path);
        relatedNotes.push({ target: describeWorkspaceDomainTarget(path), excerpt });
      }
    } catch {
      // Related notes are a convenience projection. The authored profile and
      // manuscript evidence remain valid if no matching note can be listed.
    }
    return {
      subject: element.name,
      query,
      excerpts,
      directRelations,
      relatedNotes,
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

    const structuredOccurrences = structuredWorkspaceMatches(
      projectId,
      entries,
      prefix,
      query,
    );
    if (prefix === '/comments' || prefix === '/relations') {
      return {
        query,
        path: prefix,
        matches: structuredOccurrences.slice(0, limit),
        total: structuredOccurrences.length,
        exact: true,
        truncated: structuredOccurrences.length > limit,
        ranking: 'literal-authored-structure-v1',
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
      aliases?: string[];
      line?: number;
      snippet: string;
      score: number;
      matchedTerms: string[];
      freshness: unknown;
    }> = [];
    const seen = new Set<string>();
    for (const match of structuredOccurrences) {
      const key = `${match.path}:${match.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        path: match.path,
        name: match.name,
        ...(match.aliases.length > 0 ? { aliases: match.aliases } : {}),
        ...(match.line ? { line: match.line } : {}),
        snippet: match.snippet,
        score: 100,
        matchedTerms: [query],
        freshness: null,
      });
    }
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
        ...(workspaceElementAliases(entry).length > 0
          ? { aliases: workspaceElementAliases(entry) }
          : {}),
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
        ...(workspaceElementAliases(entry).length > 0
          ? { aliases: workspaceElementAliases(entry) }
          : {}),
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

  private async enrichMissingAuthoredTarget(
    projectId: string,
    requestedPath: unknown,
    baseMessage: string,
    request: AgentToolExecutionRequest,
  ): Promise<string> {
    const query = missingAuthoredTargetQuery(requestedPath);
    if (!query) return baseMessage;
    try {
      const related = await this.grep(projectId, {
        ...request,
        name: 'grep',
        arguments: { query, path: '/', limit: 4 },
      });
      const entries = buildWorkspaceEntries(projectId);
      const evidence: string[] = [];
      for (const raw of recordArray(related, 'matches')) {
        const path = typeof raw.path === 'string' ? raw.path : '';
        let snippet = typeof raw.snippet === 'string' ? raw.snippet.trim() : '';
        const entry = entries.find((candidate) => candidate.path === path);
        if (entry) {
          const content = await this.renderEntry(entry, request);
          snippet = authoredQueryExcerpt(content, query) || snippet;
        }
        if (!path || !snippet) continue;
        evidence.push(
          `- ${describeWorkspaceDomainTarget(path)}：${sliceCodePoints(
            projectAuthoredTextForModel(snippet).text,
            0,
            1_600,
          )}`,
        );
      }
      return evidence.length > 0
        ? `${baseMessage}\n现有相关作者素材（已给出完整相关段落，无需另行打开整份灵感）：\n${evidence.join('\n')}`
        : baseMessage;
    } catch {
      // Related-material discovery is a convenience projection. The original
      // missing-object result remains correct if search is unavailable.
      return baseMessage;
    }
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
    observeProseRead?: (read: CanonicalReadResult) => void,
  ): Promise<string> {
    const target = entry.target;
    if (target.kind === 'overview') {
      const read = await this.canonicalRead(request, 'get_overview', {}, 'overview');
      return renderOverview(read.value);
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
        fromAliases: entityAliases(state, relation.fromKind, relation.fromId),
        toKind: relation.toKind,
        to: entityDisplayName(state, relation.toKind, relation.toId),
        toAliases: entityAliases(state, relation.toKind, relation.toId),
        // The author-facing relation is already rendered as “关联” when its
        // stored optional label is empty. Put that same semantic value in the
        // editable projection so revising “关联” updates the field instead of
        // failing against an invisible null.
        kind: relation.kind?.trim() || '关联',
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
        observeProseRead?.(read);
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
        observeProseRead?.(read);
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
        observeProseRead?.(read);
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
      observeProseRead?.(read);
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
  ): Promise<{
    expectedRevision: Record<string, string>;
    command: WorkspaceCommand;
    skippedStale?: number;
    changeSummary?: string;
    remainingWork?: string;
    authoredReadState?: WorkspaceAuthoredReadState;
  }> {
    if (!entry.writable) {
      throw new Error(`"${entry.path}" is read-only in this version of the workspace`);
    }
    const target = entry.target;
    const proseTarget = workspaceProseTarget(target);
    if (proseTarget) {
      const entityKind = `${proseTarget.entityType}_prose`;
      const citedExpectedRevision = expectedRevisionFromFreshness(
        this.readCoverage.get(this.readCoverageKey(request, entry.path))?.freshness,
        entityKind,
        proseTarget.id,
      );
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
      const currentExpectedRevision = expectedRevisionFrom(
        read,
        entityKind,
        proseTarget.id,
      );
      // Do not silently replace the model-visible read with this hidden
      // preparation read. If another collaborator advanced Yjs in between,
      // preserve the cited receipt so the certified write path can attribute
      // the conflict as self, another Agent, author, mixed, or unknown. The
      // mutation never reaches strategy preparation on this stale branch.
      if (
        citedExpectedRevision &&
        citedExpectedRevision.revision !== currentExpectedRevision.revision
      ) {
        return {
          expectedRevision: citedExpectedRevision,
          command: {
            name: 'edit_prose_file',
            arguments: {
              entity: proseTarget.id,
              kind:
                proseTarget.entityType === 'node'
                  ? proseTarget.nodeKind
                  : proseTarget.entityType,
              replacements,
              expectedRevision: citedExpectedRevision,
            },
          },
        };
      }
      const blocks = compactProseBlocks(read.value);
      const current = blocks.map((block) => block.displayText).join('\n\n');
      const normalized = normalizeWorkspaceProseReplacements(
        current,
        replacements,
      );
      const next = applyWorkspaceTextReplacements(current, normalized.replacements);
      const impact = inferAuthoredChangeImpact(
        entry.path,
        current,
        next,
        normalized.skippedStaleTargets,
      );
      const expectedRevision = currentExpectedRevision;
      const authoredReadState = authoredReadStateForWorkspaceEntry(
        entry,
        this.requireProject(request.context),
        {
          completeBodyRead: await this.hasCompleteWholeFileRead(
            entry.path,
            current,
            request,
          ),
          focusedBodyEdit: true,
          currentPassages: normalized.replacements
            .map((replacement) =>
              projectAuthoredTextForModel(replacement.newText).text.trim(),
            )
            .filter(Boolean)
            .slice(0, 12),
        },
      );
      return {
        expectedRevision,
        ...(authoredReadState ? { authoredReadState } : {}),
        ...(normalized.skippedStale > 0 ? { skippedStale: normalized.skippedStale } : {}),
        ...(impact.changeSummary ? { changeSummary: impact.changeSummary } : {}),
        ...(impact.remainingWork ? { remainingWork: impact.remainingWork } : {}),
        command: {
          name: 'edit_prose_file',
          arguments: {
            entity: proseTarget.id,
            kind: proseTarget.entityType === 'node' ? proseTarget.nodeKind : proseTarget.entityType,
            replacements: normalized.replacements,
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
      const impact =
        target.kind === 'node_summary'
          ? inferAuthoredChangeImpact(entry.path, current.summary, next)
          : {};
      return {
        expectedRevision,
        ...(target.kind === 'node_summary'
          ? {
              authoredReadState: {
                targetKey: `node:${target.nodeId}`,
                target: describeWorkspaceDomainTarget(
                  entry.path.replace(/\/summary\.md$/u, '/prose.md'),
                ),
                summary: next,
                completeBodyRead: false,
                focusedBodyEdit: false,
                currentPassages: [],
              },
            }
          : {}),
        ...(impact.changeSummary ? { changeSummary: impact.changeSummary } : {}),
        ...(impact.remainingWork ? { remainingWork: impact.remainingWork } : {}),
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
      let impact: { changeSummary?: string; remainingWork?: string } = {};
      switch (target.kind) {
        case 'element_summary': {
          const currentSummary = String(value.summary ?? '');
          const nextSummary = applyWorkspaceTextReplacements(currentSummary, replacements);
          update.summary = nextSummary;
          impact = inferAuthoredChangeImpact(entry.path, currentSummary, nextSummary);
          break;
        }
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
        ...(target.kind === 'element_summary'
          ? {
              authoredReadState: authoredReadStateForWorkspaceEntry(
                entry,
                this.requireProject(request.context),
                {
                  summary: String(update.summary ?? ''),
                  completeBodyRead: false,
                  focusedBodyEdit: false,
                  currentPassages: [],
                },
              ),
            }
          : {}),
        ...(impact.changeSummary ? { changeSummary: impact.changeSummary } : {}),
        ...(impact.remainingWork ? { remainingWork: impact.remainingWork } : {}),
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
      let impact: { changeSummary?: string; remainingWork?: string } = {};
      switch (target.kind) {
        case 'storyline_summary': {
          const currentSummary = String(value.summary ?? '');
          const nextSummary = applyWorkspaceTextReplacements(currentSummary, replacements);
          update.summary = nextSummary;
          impact = inferAuthoredChangeImpact(entry.path, currentSummary, nextSummary);
          break;
        }
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
        ...(target.kind === 'storyline_summary'
          ? {
              authoredReadState: authoredReadStateForWorkspaceEntry(
                entry,
                this.requireProject(request.context),
                {
                  summary: String(update.summary ?? ''),
                  completeBodyRead: false,
                  focusedBodyEdit: false,
                  currentPassages: [],
                },
              ),
            }
          : {}),
        ...(impact.changeSummary ? { changeSummary: impact.changeSummary } : {}),
        ...(impact.remainingWork ? { remainingWork: impact.remainingWork } : {}),
        command: { name: 'update_storyline', arguments: update },
      };
    }
    throw new Error(`"${entry.path}" is read-only in this version of the workspace`);
  }

  /**
   * A quoted passage is a stronger locator than an accidentally misnamed
   * chapter. Score each fully-read object of the same author-domain kind by
   * how many proposed passages it actually contains, then route to the one
   * strictly dominant object before creating any durable child read. Rows that
   * belong elsewhere remain unfinished instead of moving a second object inside
   * the same review. Ties and unread candidates keep the ordinary fail-closed
   * behavior.
   */
  private resolveUniqueReadProseEditTarget(
    requestedEntry: WorkspaceEntry,
    replacements: readonly WorkspaceTextReplacement[],
    request: AgentToolExecutionRequest,
  ): WorkspaceEntry {
    const requestedTarget = workspaceProseTarget(requestedEntry.target);
    if (!requestedTarget) return requestedEntry;
    const projectId = this.requireProject(request.context);
    const requestedCoverage = this.readCoverage.get(
      this.readCoverageKey(request, requestedEntry.path),
    );
    if (!requestedCoverage?.completeContent) return requestedEntry;
    let bestEntry = requestedEntry;
    let bestScore = countApplicableWorkspaceReplacements(
      requestedCoverage.completeContent,
      replacements,
    );
    let bestIsTied = false;
    for (const candidate of buildWorkspaceEntries(projectId)) {
      if (candidate.path === requestedEntry.path || !candidate.writable) continue;
      const candidateTarget = workspaceProseTarget(candidate.target);
      if (!sameWorkspaceProseDomainKind(requestedTarget, candidateTarget)) continue;
      const coverage = this.readCoverage.get(this.readCoverageKey(request, candidate.path));
      if (!coverage?.completeContent) continue;
      const score = countApplicableWorkspaceReplacements(
        coverage.completeContent,
        replacements,
      );
      if (score > bestScore) {
        bestEntry = candidate;
        bestScore = score;
        bestIsTied = false;
      } else if (score > 0 && score === bestScore) {
        bestIsTied = true;
      }
    }
    return bestScore > 0 && !bestIsTied ? bestEntry : requestedEntry;
  }

  private async prepareWholeFileCommand(
    entry: WorkspaceEntry,
    content: string,
    request: AgentToolExecutionRequest,
    summary?: string,
  ): Promise<{
    expectedRevision: Record<string, string>;
    command: WorkspaceCommand;
    changeSummary?: string;
    remainingWork?: string;
    authoredReadState?: WorkspaceAuthoredReadState;
  }> {
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
      const annotatedContent = restoreAuthoredTextAnnotations(current, content);
      const currentSummary = authoredObjectSummary(entry, this.requireProject(request.context)) ?? '';
      if (
        current === annotatedContent &&
        (summary === undefined || summary === currentSummary)
      ) {
        throw new Error(`"${entry.path}" already has the requested contents`);
      }
      await this.requireCompleteWholeFileRead(entry.path, current, request);
      const expectedRevision = expectedRevisionFrom(
        read,
        `${proseTarget.entityType}_prose`,
        proseTarget.id,
      );
      const impact = inferAuthoredChangeImpact(entry.path, current, annotatedContent);
      return {
        expectedRevision,
        authoredReadState: authoredReadStateForWorkspaceEntry(
          entry,
          this.requireProject(request.context),
          {
            summary: summary ?? currentSummary,
            completeBodyRead: true,
            focusedBodyEdit: false,
            currentPassages: [],
          },
        ),
        ...(impact.changeSummary ? { changeSummary: impact.changeSummary } : {}),
        ...(impact.remainingWork ? { remainingWork: impact.remainingWork } : {}),
        command: {
          name: 'edit_prose_file',
          arguments: {
            entity: proseTarget.id,
            kind: proseTarget.entityType === 'node' ? proseTarget.nodeKind : proseTarget.entityType,
            content: annotatedContent,
            ...(proseTarget.entityType === 'node' && summary !== undefined
              ? { summary }
              : {}),
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
    freshness?: ReadFreshness | null,
  ): Promise<void> {
    const key = this.readCoverageKey(request, path);
    const fingerprint = await workspaceContentFingerprint(content);
    const previous = this.readCoverage.get(key);
    const ranges =
      previous?.fingerprint === fingerprint && previous.totalChars === totalChars
        ? [...previous.ranges, { start, end }]
        : [{ start, end }];
    const sameContent =
      previous?.fingerprint === fingerprint && previous.totalChars === totalChars;
    const retainedFreshness = freshness ?? (sameContent ? previous?.freshness : undefined);
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
    const completeContent =
      merged.length === 1 && merged[0]!.start === 0 && merged[0]!.end >= totalChars
        ? content
        : undefined;
    this.readCoverage.delete(key);
    this.readCoverage.set(key, {
      fingerprint,
      totalChars,
      ranges: merged,
      ...(completeContent !== undefined ? { completeContent } : {}),
      ...(retainedFreshness
        ? {
            freshness: {
              receiptId: retainedFreshness.receiptId,
              observations: retainedFreshness.observations.map((observation) => ({
                ...observation,
              })),
            },
          }
        : {}),
    });
    while (this.readCoverage.size > MAX_TRACKED_READ_COVERAGE) {
      const oldest = this.readCoverage.keys().next().value as string | undefined;
      if (!oldest) break;
      this.readCoverage.delete(oldest);
    }
    let cachedCompleteReads = [...this.readCoverage.values()].filter(
      (coverage) => coverage.completeContent !== undefined,
    ).length;
    if (cachedCompleteReads > MAX_CACHED_COMPLETE_READS) {
      for (const coverage of this.readCoverage.values()) {
        if (coverage.completeContent === undefined) continue;
        delete coverage.completeContent;
        cachedCompleteReads -= 1;
        if (cachedCompleteReads <= MAX_CACHED_COMPLETE_READS) break;
      }
    }
  }

  private async requireCompleteWholeFileRead(
    path: string,
    current: string,
    request: AgentToolExecutionRequest,
  ): Promise<void> {
    if (await this.hasCompleteWholeFileRead(path, current, request)) return;
    const target = describeWorkspaceDomainTarget(path);
    throw new Error(
      `INCOMPLETE_AUTHORED_OBJECT_READ: ${target} cannot be completely rewritten yet because its current body has not been fully read. ` +
        'Continue the matching domain read with its returned cursor until the complete body is available, or use the matching revise tool for a focused passage change. The text was not changed.',
    );
  }

  private async hasCompleteWholeFileRead(
    path: string,
    current: string,
    request: AgentToolExecutionRequest,
  ): Promise<boolean> {
    if (!current) return true;
    const coverage = this.readCoverage.get(this.readCoverageKey(request, path));
    const totalChars = codePointLength(current);
    return Boolean(
      coverage?.totalChars === totalChars &&
      coverage.fingerprint === (await workspaceContentFingerprint(current)) &&
      coverage.ranges.length === 1 &&
      coverage.ranges[0]!.start === 0 &&
      coverage.ranges[0]!.end >= totalChars,
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
  ): Promise<{
    expectedRevision: Record<string, string>;
    command: WorkspaceCommand;
    authoredReadState?: WorkspaceAuthoredReadState;
  }> {
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
        authoredReadState: authoredReadStateForWorkspaceEntry(
          entry,
          this.requireProject(request.context),
          {
            summary: content,
            completeBodyRead: false,
            focusedBodyEdit: false,
            currentPassages: [],
          },
        ),
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
        ...(target.kind === 'element_summary'
          ? {
              authoredReadState: authoredReadStateForWorkspaceEntry(
                entry,
                this.requireProject(request.context),
                {
                  summary: content,
                  completeBodyRead: false,
                  focusedBodyEdit: false,
                  currentPassages: [],
                },
              ),
            }
          : {}),
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
        authoredReadState: authoredReadStateForWorkspaceEntry(
          entry,
          this.requireProject(request.context),
          {
            summary: content,
            completeBodyRead: false,
            focusedBodyEdit: false,
            currentPassages: [],
          },
        ),
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
    explicitSummary?: string,
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
      if (!title || segments.length !== 3) {
        throw new Error('章节或灵感的名称不完整，无法新建。');
      }
      const body = stripRedundantLeadingAuthoredTitle(content, title);
      return {
        expectedRevision,
        command: {
          name: 'create_node',
          arguments: {
            kind: segments[0] === 'chapters' ? 'chapter' : 'drift',
            title,
            body,
            ...(explicitSummary ? { summary: explicitSummary } : {}),
            expectedRevision,
          },
        },
      };
    }
    if (segments[0] === 'elements' && file === 'body.md' && segments.length === 4) {
      const body = stripRedundantLeadingAuthoredTitle(content, segments[2] ?? '');
      const summary = explicitSummary || initialStructuredSummary(body);
      return {
        expectedRevision,
        command: {
          name: 'create_element',
          arguments: {
            category: segments[1],
            name: segments[2],
            body,
            ...(summary ? { summary } : {}),
            expectedRevision,
          },
        },
      };
    }
    if (segments[0] === 'storylines' && file === 'body.md' && segments.length === 3) {
      const body = stripRedundantLeadingAuthoredTitle(content, segments[1] ?? '');
      const summary = explicitSummary || initialStructuredSummary(body);
      return {
        expectedRevision,
        command: {
          name: 'create_storyline',
          arguments: {
            name: segments[1],
            body,
            ...(summary ? { summary } : {}),
            expectedRevision,
          },
        },
      };
    }
    if (segments[0] === 'categories' && file === 'body.md' && segments.length === 3) {
      const body = stripRedundantLeadingAuthoredTitle(content, segments[1] ?? '');
      return {
        expectedRevision,
        command: {
          name: 'create_category',
          arguments: { name: segments[1], body, expectedRevision },
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
      '无法从这个名称判断要新建哪种作品对象。请使用“第二章”、“灵感「雨夜片段」”、“人物「林弦」”、“故事线「返乡」”或“要素分类「人物」”这样的作者语义名称。',
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
        `${describeWorkspaceDomainTarget(path)} is one field of an authored object. Delete only the complete ${describeWorkspaceDomainTarget(completeResource)} when that whole object should be removed.`,
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

function domainDefinition(name: DriftingDomainReadToolName): AgentToolDefinition {
  const tool = getRegisteredTool(name);
  if (!tool || tool.access !== 'read') {
    throw new Error(`Domain tool contract "${name}" is unavailable`);
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

function domainReadFileRequest(
  request: AgentToolExecutionRequest,
  path: string,
): AgentToolExecutionRequest {
  return {
    ...request,
    arguments: {
      path,
      ...(request.arguments.cursor !== undefined
        ? { offset: request.arguments.cursor }
        : {}),
      ...(request.arguments.maxCharacters !== undefined
        ? { limit: request.arguments.maxCharacters }
        : {}),
    },
  };
}

function requiredDomainName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty name`);
  }
  return value.trim();
}

function optionalDomainText(value: unknown): string | undefined {
  return typeof value === 'string'
    ? normalizeAuthoredTextTransportArtifacts(value).trim()
    : undefined;
}

function normalizeDomainBody(value: unknown): string {
  return typeof value === 'string'
    ? normalizeAuthoredTextTransportArtifacts(value)
    : '';
}

function factsRecord(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) throw new Error('facts must be a non-empty key/value list');
  const result: Record<string, string> = {};
  for (const row of value) {
    const record = asRecord(row);
    const key = requiredDomainName(record.key, 'fact key');
    result[key] = typeof record.value === 'string' ? record.value : String(record.value ?? '');
  }
  if (Object.keys(result).length === 0) throw new Error('facts must not be empty');
  return result;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of names`);
  const result = value.map((item) => requiredDomainName(item, field));
  if (new Set(result.map((item) => item.normalize('NFKC').toLocaleLowerCase())).size !== result.length) {
    throw new Error(`${field} must not contain duplicate names`);
  }
  return result;
}

function relationKindForDomainType(value: unknown): 'node' | 'element' | 'storyline' | 'category' {
  switch (value) {
    case 'chapter':
    case 'inspiration':
      return 'node';
    case 'element':
      return 'element';
    case 'storyline':
      return 'storyline';
    case 'element_category':
      return 'category';
    default:
      throw new Error('entityType must be chapter, inspiration, element, storyline, or element_category');
  }
}

function assertDomainRelationEndpoint(
  projectId: string,
  type: unknown,
  nameValue: unknown,
): void {
  const name = requiredDomainName(nameValue, 'relation endpoint');
  const path =
    type === 'chapter'
      ? `/chapters/${pathSegment(name)}/prose.md`
      : type === 'inspiration'
        ? `/drifts/${pathSegment(name)}/prose.md`
        : type === 'storyline'
          ? `/storylines/${pathSegment(name)}/body.md`
          : type === 'element_category'
            ? `/categories/${pathSegment(name)}/body.md`
            : type === 'element'
              ? requireDomainBodyEntry(projectId, 'element', name).path
              : '';
  if (!path || !findWorkspaceEntry(projectId, path)) {
    throw new Error(`${String(type)} "${name}" does not exist in this project`);
  }
}

function requireDomainBodyEntry(
  projectId: string,
  kind: 'element' | 'storyline',
  name: string,
): WorkspaceEntry {
  if (kind === 'storyline') {
    return requireWorkspaceFileEntry(
      projectId,
      `/storylines/${pathSegment(name)}/body.md`,
      false,
    );
  }
  const entries = buildWorkspaceEntries(projectId).filter(
    (entry) => entry.target.kind === 'element_body',
  );
  const state = useDataStore.getState();
  const matches = entries.filter((entry) => {
    const target = entry.target;
    if (target.kind !== 'element_body') return false;
    const element = state.bookElements.find((item) => item.id === target.elementId);
    return (element ? allElementNames(element) : [target.elementName]).some((candidate) =>
      authoredNamesEqual(candidate, name),
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No element named "${name}" exists in this project`
        : `Element name "${name}" is ambiguous`,
    );
  }
  return matches[0]!;
}

function domainCommentProseEntry(
  projectId: string,
  targetType: string,
  targetName: string,
): WorkspaceEntry {
  switch (targetType) {
    case 'chapter':
      return requireWorkspaceFileEntry(
        projectId,
        `/chapters/${pathSegment(targetName)}/prose.md`,
        false,
      );
    case 'inspiration':
      return requireWorkspaceFileEntry(
        projectId,
        `/drifts/${pathSegment(targetName)}/prose.md`,
        false,
      );
    case 'element':
      return requireDomainBodyEntry(projectId, 'element', targetName);
    case 'storyline':
      return requireDomainBodyEntry(projectId, 'storyline', targetName);
    case 'element_category':
      return requireWorkspaceFileEntry(
        projectId,
        `/categories/${pathSegment(targetName)}/body.md`,
        false,
      );
    default:
      throw new Error(`Unsupported comment targetType "${targetType}"`);
  }
}

function domainProsePath(
  projectId: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName.includes('chapter')) {
    return `/chapters/${pathSegment(requiredDomainName(args.chapter, 'chapter'))}/prose.md`;
  }
  if (toolName.includes('inspiration')) {
    return `/drifts/${pathSegment(requiredDomainName(args.inspiration, 'inspiration'))}/prose.md`;
  }
  if (toolName.includes('element_category')) {
    return `/categories/${pathSegment(requiredDomainName(args.category, 'category'))}/body.md`;
  }
  if (toolName.includes('element')) {
    return requireDomainBodyEntry(
      projectId,
      'element',
      requiredDomainName(args.element, 'element'),
    ).path;
  }
  return `/storylines/${pathSegment(requiredDomainName(args.storyline, 'storyline'))}/body.md`;
}

function domainCompleteObjectPath(
  projectId: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const label = toolName === 'delete_chapter'
    ? `章节「${requiredDomainName(args.chapter, 'chapter')}」`
    : toolName === 'delete_inspiration'
      ? `灵感「${requiredDomainName(args.inspiration, 'inspiration')}」`
      : toolName === 'delete_storyline'
        ? `故事线「${requiredDomainName(args.storyline, 'storyline')}」`
        : `要素分类「${requiredDomainName(args.category, 'category')}」`;
  return resolveWorkspaceCompleteObjectPath(projectId, label);
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
      description: describeCommentForAuthor(state, comment),
      target: { kind: 'comment', commentId: comment.id },
    });
  }
  for (const relation of state.entityRelations.filter((item) => item.projectId === projectId)) {
    entries.push({
      path: `/relations/${pathSegment(relation.id)}.json`,
      writable: true,
      description: describeRelationForAuthor(state, relation),
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

function elementAliases(element: BookElement): string[] {
  const canonical = element.name.trim().toLocaleLowerCase();
  return allElementNames(element).filter(
    (candidate) => candidate.toLocaleLowerCase() !== canonical,
  );
}

function workspaceElementAliases(entry: WorkspaceEntry): string[] {
  const target = entry.target;
  if (!isElementTarget(target)) return [];
  const element = useDataStore
    .getState()
    .bookElements.find((candidate) => candidate.id === target.elementId);
  return element ? elementAliases(element) : [];
}

function workspaceDirectoryElementAliases(
  path: string,
  entries: readonly WorkspaceEntry[],
): string[] {
  const segments = path.split('/').filter(Boolean);
  if (segments[0] !== 'elements' || segments.length !== 3) return [];
  for (const entry of entries) {
    const aliases = workspaceElementAliases(entry);
    if (aliases.length > 0) return aliases;
  }
  return [];
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

function renderOverview(value: unknown): string {
  const overview = asRecord(value);
  const counts = asRecord(overview.counts);
  return [
    `# ${String(overview.name ?? 'Drifting project')}`,
    '',
    String(overview.description ?? '').trim(),
    '',
    '## 作品内容',
    '',
    '- 章节：按作品顺序排列的正文与摘要',
    '- 灵感：可自由组织的创作片段',
    '- 要素：人物、地点、组织、物件与其他设定',
    '- 故事线：故事线说明及其章节关系',
    '- 批注与待办：作者的编辑记录',
    '- 实体关系：要素之间由作者确认的关系',
    '- 作者规则：本作品希望 Agent 遵循的可编辑规则',
    '- 素材：只读参考材料',
    '',
    '正文以作者在编辑器中看到的文本交给 Agent；人物连接、保存、并发保护、审阅和撤销均由 Drifting 自动处理。',
    '',
    '## 数量',
    '',
    `- 章节：${Number(counts.chapters ?? 0)}`,
    `- 灵感：${Number(counts.drifts ?? 0)}`,
    `- 故事线：${Number(counts.storylines ?? 0)}`,
    `- 要素：${Number(counts.elements ?? 0)}`,
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n')
    .trim();
}

function renderComments(value: unknown): string {
  const comments = recordArray(value, 'comments');
  if (comments.length === 0) return '# 批注与待办\n\n暂无。';
  return [
    '# 批注与待办',
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
        `- 类型：${kind}；状态：${status}；作者：${author}`,
        ...(quote ? [`- 引用正文（仅锚点片段）：${quote}`] : []),
        '',
        body || '（无内容）',
        '',
      ];
    }),
  ]
    .join('\n')
    .trim();
}

function renderMemories(value: unknown): string {
  const memories = recordArray(value, 'memories');
  if (memories.length === 0) return '# 作者规则\n\n暂无。';
  return [
    '# 作者规则',
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
  const expected = expectedRevisionFromFreshness(
    read.freshness ?? undefined,
    entityKind,
    entityId,
  );
  if (!expected) {
    throw new Error('The runtime could not obtain an exact revision for this file; retry the edit');
  }
  return expected;
}

function expectedRevisionFromFreshness(
  freshness: ReadFreshness | undefined,
  entityKind: string,
  entityId: string,
): Record<string, string> | null {
  const observation = freshness?.observations.find(
    (candidate) => candidate.entityKind === entityKind && candidate.entityId === entityId,
  );
  if (!freshness || !observation) return null;
  return {
    receiptId: freshness.receiptId,
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

function structuredWorkspaceMatches(
  projectId: string,
  entries: readonly WorkspaceEntry[],
  prefix: string,
  query: string,
): Array<{ path: string; name: string; aliases: string[]; line: number; snippet: string }> {
  const state = useDataStore.getState();
  const matches = entries.flatMap((entry) => {
    if (!pathIsWithin(entry.path, prefix)) return [];
    const target = entry.target;
    if (target.kind === 'comment') {
      const comment = state.comments.find(
        (candidate) =>
          candidate.id === target.commentId && candidate.projectId === projectId,
      );
      if (!comment) return [];
      return literalWorkspaceMatches(entry, describeCommentForAuthor(state, comment), query);
    }
    if (target.kind === 'relation') {
      const relation = state.entityRelations.find(
        (candidate) =>
          candidate.id === target.relationId && candidate.projectId === projectId,
      );
      if (!relation) return [];
      return literalWorkspaceMatches(entry, describeRelationForAuthor(state, relation), query);
    }
    return [];
  });
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.path}:${match.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function containsLiteralQuery(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function literalWorkspaceMatches(
  entry: WorkspaceEntry,
  content: string,
  query: string,
): Array<{ path: string; name: string; aliases: string[]; line: number; snippet: string }> {
  const occurrences: Array<{
    path: string;
    name: string;
    aliases: string[];
    line: number;
    snippet: string;
  }> = [];
  const searchableContent = content.toLocaleLowerCase();
  const searchableQuery = query.toLocaleLowerCase();
  let cursor = 0;
  while (cursor <= content.length) {
    const index = searchableContent.indexOf(searchableQuery, cursor);
    if (index < 0) break;
    const lineStart = content.lastIndexOf('\n', index - 1) + 1;
    const nextBreak = content.indexOf('\n', index + query.length);
    const lineEnd = nextBreak < 0 ? content.length : nextBreak;
    occurrences.push({
      path: entry.path,
      name: workspaceEntryDisplayName(entry),
      aliases: workspaceElementAliases(entry),
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

function sameWorkspaceProseDomainKind(
  left: WorkspaceProseTarget,
  right: WorkspaceProseTarget | null,
): boolean {
  if (!right || left.entityType !== right.entityType) return false;
  if (left.entityType !== 'node' || right.entityType !== 'node') return true;
  return left.nodeKind === right.nodeKind;
}

/** Translate the domain-native provider shape into the exact-text mutation
 * primitive used by the hidden Yjs/SQLite command layer. The provider never
 * needs to reason about that transport representation. */
function parseWorkspaceDomainChanges(value: unknown): WorkspaceTextReplacement[] {
  if (!Array.isArray(value)) {
    throw new Error('A focused revision requires at least one change.');
  }
  return parseWorkspaceTextReplacements(
    value.map((raw) => {
      const change = asRecord(raw);
      return {
        oldText: change.currentText,
        newText: change.revisedText,
        ...(change.allOccurrences === true ? { replaceAll: true } : {}),
      };
    }),
  );
}

function countApplicableWorkspaceReplacements(
  content: string,
  replacements: readonly WorkspaceTextReplacement[],
): number {
  let matches = 0;
  for (const replacement of replacements) {
    try {
      const normalized = normalizeWorkspaceProseReplacements(content, [replacement]);
      if (normalized.skippedStale === 0 && normalized.replacements.length === 1) {
        matches += 1;
      }
    } catch {
      // Missing, ambiguous, or already-satisfied text is not a locator.
    }
  }
  return matches;
}

function normalizeEntityKind(kind: string): string {
  return kind === 'node' ? 'chapter' : kind;
}

function normalizeVirtualPath(value: unknown): string {
  const raw =
    String(value ?? '/')
      .trim()
      .replace(/([」”"])\s*[（(]别名[：:][^）)]*[）)]/gu, '$1') || '/';
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  const normalized = prefixed.length > 1 ? prefixed.replace(/\/+$/g, '') : prefixed;
  if (normalized.includes('\u0000') || normalized.split('/').includes('..')) {
    throw new Error('Invalid virtual workspace path');
  }
  return normalized;
}

function publicDomainReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The project object could not be read';
  if (/requires a non-empty query/iu.test(message)) {
    return 'Project search requires a non-empty query.';
  }
  if (
    /(?:virtual|workspace|file|directory|path)/iu.test(message) ||
    /\b(?:json|yjs|sqlite|receipt|revision|nodeId|entityId)\b/iu.test(message) ||
    /\/(?:chapters|drifts|elements|storylines|categories|comments|relations|memory)(?:\/|\b)/iu.test(
      message,
    )
  ) {
    return 'The requested authored object or collection is unavailable. Use its author-facing name, or browse the relevant project collection if the author did not name an exact target.';
  }
  return message;
}

function defaultAuthoredChangeSummary(path: string): string | undefined {
  if (path.endsWith('/summary.md')) return '已同步整理摘要';
  if (path.endsWith('/title.txt')) return '已更新标题';
  return undefined;
}

function inferAuthoredChangeImpact(
  path: string,
  before: string,
  after: string,
  skippedStaleTargets: readonly string[] = [],
): { changeSummary?: string; remainingWork?: string } {
  if (path.endsWith('/summary.md')) {
    if (!after.trim()) {
      return {
        changeSummary: before.trim() ? '已清空摘要' : '摘要仍为空',
        remainingWork: '当前摘要为空，需要补写',
      };
    }
    return {
      changeSummary: before.trim() ? '已同步整理摘要' : '已补写摘要',
    };
  }
  const fallback = defaultAuthoredChangeSummary(path);
  if (!path.endsWith('/prose.md') && !path.endsWith('/body.md')) {
    return fallback ? { changeSummary: fallback } : {};
  }
  const beforeWords = countWords(before);
  const afterWords = countWords(after);
  const changeSummary =
    beforeWords === afterWords
      ? '完成正文修改'
      : `将正文从 ${beforeWords} 字调整为 ${afterWords} 字`;
  return {
    changeSummary,
    ...(skippedStaleTargets.length > 0
      ? { remainingWork: describeStaleAuthoredTargets(skippedStaleTargets) }
      : {}),
  };
}

function describeStaleAuthoredTargets(targets: readonly string[]): string {
  return `${targets.length} 处局部修改因正文已变化而跳过；只有它仍影响作者目标时，才需在附近正文中重新定位一次`;
}

/**
 * Let the model address an authored resource by its semantic directory. The
 * virtual filesystem still resolves the operation to the same certified
 * prose/body command; this only removes product-internal filename trivia from
 * the public write contract.
 */
function semanticAuthoredCreationPath(projectId: string, path: string): string | null {
  const chapterLabel = /^\/章节[「“"](.+?)[」”"]$/u.exec(path)?.[1]?.trim();
  const naturalChapter = /^\/(第[〇零一二三四五六七八九十百两\d]+章)$/u.exec(path)?.[1];
  const chapter = chapterLabel ?? naturalChapter;
  if (chapter) {
    const ordinal = parseChapterOrdinal(chapter);
    const title = ordinal === null ? chapter : canonicalNewChapterTitle(projectId, ordinal);
    return `/chapters/${pathSegment(title)}/prose.md`;
  }
  const drift = /^\/(?:灵感|漂移)[「“"](.+?)[」”"]$/u.exec(path)?.[1]?.trim();
  if (drift) return `/drifts/${pathSegment(drift)}/prose.md`;
  const storyline = /^\/故事线[「“"](.+?)[」”"]$/u.exec(path)?.[1]?.trim();
  if (storyline) return `/storylines/${pathSegment(storyline)}/body.md`;
  const category = /^\/要素分类[「“"](.+?)[」”"]$/u.exec(path)?.[1]?.trim();
  if (category) return `/categories/${pathSegment(category)}/body.md`;
  const qualifiedElement = parseQualifiedElementTarget(path);
  if (qualifiedElement) {
    return `/elements/${pathSegment(qualifiedElement.categoryName)}/${pathSegment(qualifiedElement.name)}/body.md`;
  }
  const element = /^\/(人物|角色|地点|区域|组织|势力|物品|道具|要素)[「“"](.+?)[」”"]$/u.exec(
    path,
  );
  if (element) {
    const categoryName = semanticElementCategory(projectId, element[1]!);
    const name = element[2]!.trim();
    if (categoryName && name) {
      return `/elements/${pathSegment(categoryName)}/${pathSegment(name)}/body.md`;
    }
  }
  return null;
}

function parseQualifiedElementTarget(
  value: string,
): { name: string; categoryName: string } | null {
  const match =
    /^\/?要素[「“"](.+?)[」”"]\s*[（(]\s*分类[「“"](.+?)[」”"]\s*[）)]$/u.exec(value);
  const name = match?.[1]?.trim();
  const categoryName = match?.[2]?.trim();
  return name && categoryName ? { name, categoryName } : null;
}

function canonicalNewChapterTitle(projectId: string, ordinal: number): string {
  const numericTitles = useDataStore
    .getState()
    .bookNodes.filter(
      (node) => node.projectId === projectId && node.kind === 'chapter' && /^\d+$/u.test(node.title),
    )
    .map((node) => node.title);
  const width = Math.max(1, ...numericTitles.map((title) => title.length));
  return String(ordinal).padStart(width, '0');
}

function semanticElementCategory(projectId: string, label: string): string | null {
  const categories = useDataStore
    .getState()
    .bookElementCategories.filter((category) => category.projectId === projectId);
  const exact = categories.filter((category) => category.name.trim() === label);
  if (exact.length === 1) return exact[0]!.name;
  const aliases: Record<string, RegExp> = {
    人物: /人物|角色/u,
    角色: /人物|角色/u,
    地点: /地点|区域|国家|地理/u,
    区域: /地点|区域|国家|地理/u,
    组织: /组织|势力|机构/u,
    势力: /组织|势力|机构/u,
    物品: /物品|道具|器物/u,
    道具: /物品|道具|器物/u,
  };
  const pattern = aliases[label];
  if (!pattern) return null;
  const matches = categories.filter((category) => pattern.test(category.name));
  return matches.length === 1 ? matches[0]!.name : null;
}

function workspaceReadModelData(value: unknown): string {
  const result = asRecord(value);
  const path = typeof result.path === 'string' ? result.path : '/';
  if (result.missing === true && typeof result.missingMessage === 'string') {
    return result.missingMessage;
  }
  if (Array.isArray(result.files)) {
    const lines = [
      ...new Set(
        result.files.flatMap((raw) => {
          const file = asRecord(raw);
          if (typeof file.path !== 'string') return [];
          const preview = workspaceDomainListPreview(file.path, file.description);
          const target = authoredTargetWithAliases(
            workspaceDomainListItem(file.path),
            file.aliases,
          );
          return [preview ? `${target} — ${preview}` : target];
        }),
      ),
    ];
    if (result.truncated === true) {
      lines.push(
        path === '/comments' || path === '/relations'
          ? '（这里只展示部分内容；可按人物、主题或明显的测试词搜索全部内容。）'
          : '（还有更多内容）',
      );
    }
    const creationHint = workspaceDomainCreationHint(path);
    if (creationHint) {
      lines.push('', creationHint);
    }
    return [workspaceDomainListHeading(path), ...lines].join('\n');
  }
  if (typeof result.content === 'string') {
    const target = authoredTargetWithAliases(
      describeWorkspaceDomainTarget(path),
      result.aliases,
    );
    const structured = structuredAuthoredObjectForModel(path, result.content);
    const authored = structured
      ? { text: structured, linkedMentions: [] as string[] }
      : projectAuthoredTextForModel(result.content);
    const summaryReference = chapterSummaryReference(path);
    const summary =
      typeof result.summary === 'string'
        ? `\n摘要${summaryReference ? `（${summaryReference}）` : ''}：${result.summary.trim() || '（暂无）'}`
        : '';
    const wordCount =
      typeof result.wordCount === 'number' && Number.isFinite(result.wordCount)
        ? `\n字数：${result.wordCount}`
        : '';
    const continuation =
      result.truncated === true && typeof result.nextOffset === 'number'
        ? `\n\n[这份内容尚未读完；继续读取时使用 cursor ${result.nextOffset}。]`
        : '';
    const linkedMentions =
      authored.linkedMentions.length > 0
        ? `\n正文中的实体连接：${authored.linkedMentions.join('、')}`
        : '';
    const authoredText = authored.text.trim()
      ? authored.text
      : emptyAuthoredFieldForModel(path);
    const relatedContext = elementRelatedContextForModel(result.relatedContext);
    return `${target}${wordCount}${summary}${linkedMentions}\n\n${authoredText}${continuation}${relatedContext}`;
  }
  if (Array.isArray(result.matches)) {
    const query = typeof result.query === 'string' ? result.query : '';
    const matches = result.matches.flatMap((raw) => {
      const match = asRecord(raw);
      if (typeof match.path !== 'string') return [];
      const line = typeof match.line === 'number' ? `，第 ${match.line} 段` : '';
      const snippet = typeof match.snippet === 'string' ? match.snippet : '';
      const target = authoredTargetWithAliases(
        describeWorkspaceDomainTarget(match.path),
        match.aliases,
      );
      return [`${target}${line}：${snippet}`];
    });
    const total =
      typeof result.total === 'number' && Number.isFinite(result.total)
        ? Math.max(0, Math.trunc(result.total))
        : matches.length;
    const header = result.exact === true ? `精确出现次数：${total}` : `搜索结果：${total}`;
    if (matches.length === 0) {
      return `${header}\n在${describeWorkspaceDomainTarget(path)}中没有找到「${query}」。`;
    }
    if (result.truncated === true) matches.push('（还有更多结果）');
    return [header, ...matches].join('\n');
  }
  return prettyJson(value);
}

function authoredTargetWithAliases(target: string, value: unknown): string {
  const aliases = Array.isArray(value)
    ? value
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    : [];
  if (aliases.length === 0) return target;
  const quoteEnd = target.indexOf('」');
  const annotation = `（别名：${aliases.join('、')}）`;
  return quoteEnd >= 0
    ? `${target.slice(0, quoteEnd + 1)}${annotation}${target.slice(quoteEnd + 1)}`
    : `${target}${annotation}`;
}

function workspaceDomainListHeading(path: string): string {
  const headings: Readonly<Record<string, string>> = {
    '/': '作品包含',
    '/chapters': '现有章节',
    '/drifts': '现有灵感',
    '/elements': '现有要素分类',
    '/storylines': '现有故事线',
    '/categories': '现有要素分类说明',
    '/materials': '现有参考素材',
    '/comments': '现有批注或待办',
    '/relations': '现有实体关系',
    '/memory': '现有作者规则',
  };
  if (headings[path]) return headings[path]!;
  return `${describeWorkspaceDomainTarget(path)}中的内容`;
}

function workspaceDomainListItem(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'categories' && segments.length === 2) {
    return `要素分类「${decodePathSegment(segments[1]!)}」`;
  }
  if (segments[0] === 'elements' && segments.length === 2) {
    return `要素分类「${decodePathSegment(segments[1]!)}」`;
  }
  return describeWorkspaceDomainTarget(path);
}

function workspaceDomainListPreview(path: string, value: unknown): string | null {
  if (!path.startsWith('/comments/') && !path.startsWith('/relations/')) return null;
  if (typeof value !== 'string') return null;
  const authored = projectAuthoredTextForModel(value).text.replace(/\s+/gu, ' ').trim();
  return authored ? sliceCodePoints(authored, 0, 220) : null;
}

function workspaceDomainCreationHint(path: string): string | null {
  if (path === '/chapters') {
    return '可直接用名称和完整初稿新建章节；标题、摘要与保存细节由 Drifting 管理。';
  }
  if (path === '/drifts') {
    return '可直接用名称和完整内容新建灵感；标题、摘要与保存细节由 Drifting 管理。';
  }
  if (path === '/elements') {
    return '要查看已有要素，请继续浏览上面的具体要素分类，例如 要素分类「人物」。新建要素时先选择或建立分类，再提供名称与设定正文。';
  }
  if (/^\/elements\/[^/]+$/u.test(path)) {
    return `可在${workspaceDomainListItem(path)}中新建要素，只需提供名称与设定正文。`;
  }
  if (path === '/storylines') return '可直接用名称与说明新建故事线。';
  if (path === '/comments') return '可新建一条批注或待办，并说明内容及其对象。';
  if (path === '/relations') return '可用准确的实体名称和关系类型建立一条实体关系。';
  if (path === '/memory') return '可新建、修改或删除作者规则。';
  return null;
}

function emptyAuthoredFieldForModel(path: string): string {
  if (path.endsWith('/summary.md')) return '摘要：尚未填写。';
  if (path.endsWith('/title.txt')) return '标题：尚未填写。';
  if (/^\/elements\/[^/]+\/[^/]+\/body\.md$/u.test(path)) {
    return '设定正文：尚未填写。';
  }
  if (/^\/(?:storylines|categories)\/[^/]+\/body\.md$/u.test(path)) {
    return '说明正文：尚未填写。';
  }
  if (path.endsWith('/prose.md')) return '正文：尚未填写。';
  return '内容：尚未填写。';
}

function elementRelatedContextForModel(value: unknown): string {
  const context = asRecord(value);
  if (!context.subject) return '';
  const relations = Array.isArray(context.directRelations)
    ? context.directRelations.filter(
        (candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim()),
      )
    : [];
  const excerpts = recordArray(context, 'excerpts').flatMap((raw) => {
    const target = typeof raw.target === 'string' ? raw.target.trim() : '';
    const excerpt = typeof raw.excerpt === 'string' ? raw.excerpt.trim() : '';
    if (!target || !excerpt) return [];
    const block = positiveInteger(raw.block);
    return [`- ${target}${block ? `，第 ${block} 段` : ''}：${excerpt}`];
  });
  const relatedNotes = recordArray(context, 'relatedNotes').flatMap((raw) => {
    const target = typeof raw.target === 'string' ? raw.target.trim() : '';
    const excerpt = typeof raw.excerpt === 'string' ? raw.excerpt.trim() : '';
    return target && excerpt ? [`- ${target}：${excerpt}`] : [];
  });
  const sections = [
    '',
    relations.length > 0
      ? `当前直接关系：\n${relations.map((relation) => `- ${relation}`).join('\n')}`
      : '当前直接关系：尚未建立。',
  ];
  if (excerpts.length > 0) {
    sections.push(
      `作品中的相关片段（当前正文证据，无需另行打开来源）：\n${excerpts.join('\n')}`,
    );
  }
  if (relatedNotes.length > 0) {
    sections.push(
      `与该人物直接相关的批注或待办（无需浏览全部批注）：\n${relatedNotes.join('\n')}`,
    );
  }
  sections.push(
    '以上档案、关系与正文片段可以直接用于当前人物交付；只有一个具体缺失事实会改变写入内容时，才需要继续定向查找。',
  );
  return `\n${sections.join('\n')}`;
}

const DOMAIN_FIELD_LABELS: Readonly<Record<string, string>> = {
  kind: '类型',
  body: '内容',
  quote: '引用正文（仅锚点片段）',
  status: '状态',
  targetKind: '对象类型',
  target: '对象',
  fromKind: '起点类型',
  from: '起点',
  fromAliases: '起点别名',
  toKind: '终点类型',
  to: '终点',
  toAliases: '终点别名',
  key: '名称',
  value: '内容',
  name: '名称',
  title: '标题',
  summary: '摘要',
  aliases: '别名',
  category: '分类',
  groupName: '分组',
  facts: '事实',
  chapters: '章节',
  primary: '主要故事线',
  writingStatus: '写作状态',
  narrativeOrder: '叙事顺序',
  bookOrder: '全书顺序',
};

function structuredAuthoredObjectForModel(path: string, content: string): string | null {
  if (!path.endsWith('.json')) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  const lines = domainValueLines(value);
  return lines.length > 0 ? lines.join('\n') : '（暂无内容）';
}

function domainValueLines(value: unknown, depth = 0): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const fields = domainRecordLines(item as Record<string, unknown>, depth + 1);
        return fields.length > 0 ? [`${index + 1}.`, ...fields.map((line) => `   ${line}`)] : [];
      }
      const rendered = domainScalarValue(item);
      return rendered ? [`- ${rendered}`] : [];
    });
  }
  if (value && typeof value === 'object') {
    return domainRecordLines(value as Record<string, unknown>, depth);
  }
  const rendered = domainScalarValue(value);
  return rendered ? [rendered] : [];
}

function domainRecordLines(record: Record<string, unknown>, depth: number): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    if (isInternalDomainField(key) || value === null || value === undefined || value === '') {
      return [];
    }
    const label = DOMAIN_FIELD_LABELS[key] ?? readableDomainField(key);
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      const nested = domainValueLines(value, depth + 1);
      return nested.length > 0
        ? [`${label}：`, ...nested.map((line) => `  ${line}`)]
        : [];
    }
    const rendered = domainFieldValue(key, value);
    return rendered ? [`${label}：${rendered}`] : [];
  });
}

function isInternalDomainField(key: string): boolean {
  return /^(?:id|projectId|nodeId|entityId|commentId|relationId|memoryId|targetBlockId|supersedesId|createdAt|updatedAt|revision|receipt)$/u.test(
    key,
  );
}

function readableDomainField(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll('_', ' ')
    .trim();
}

function domainScalarValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '';
}

function domainFieldValue(key: string, value: unknown): string {
  if (typeof value !== 'string') return domainScalarValue(value);
  if (key === 'kind') {
    if (value === 'todo') return '待办';
    if (value === 'note') return '批注';
    if (value === 'directive') return '作者规则';
  }
  if (key === 'status') {
    if (value === 'open' || value === 'pending') return '未完成';
    if (value === 'resolved' || value === 'completed') return '已完成';
  }
  if (key === 'targetKind' || key === 'fromKind' || key === 'toKind') {
    const labels: Readonly<Record<string, string>> = {
      node: '章节或灵感',
      element: '要素',
      storyline: '故事线',
      category: '要素分类',
      comment: '批注或待办',
      project: '作品',
    };
    return labels[value] ?? value;
  }
  return value;
}

function chapterSummaryReference(path: string): string | null {
  const match = /^\/chapters\/([^/]+)\/prose\.md$/u.exec(path);
  return match ? `章节「${decodePathSegment(match[1]!)}」摘要` : null;
}

function authoredObjectSummary(entry: WorkspaceEntry, projectId: string): string | null {
  const target = entry.target;
  if (target.kind === 'node_prose') {
    return currentNode(target.nodeId, projectId).summary.trim();
  }
  if (target.kind === 'element_body') {
    return (
      useDataStore
        .getState()
        .bookElements.find(
          (element) => element.projectId === projectId && element.id === target.elementId,
        )?.summary.trim() ?? ''
    );
  }
  if (target.kind === 'storyline_body') {
    return (
      useDataStore
        .getState()
        .storylines.find(
          (storyline) => storyline.projectId === projectId && storyline.id === target.storylineId,
        )?.summary.trim() ?? ''
    );
  }
  return null;
}

function authoredReadStateForWorkspaceEntry(
  entry: WorkspaceEntry,
  projectId: string,
  input: {
    summary?: string;
    completeBodyRead: boolean;
    focusedBodyEdit: boolean;
    currentPassages: string[];
  },
): WorkspaceAuthoredReadState {
  const target = entry.target;
  const identity = (() => {
    const prose = workspaceProseTarget(target);
    if (prose) {
      return {
        targetKey: `${prose.entityType}:${prose.id}`,
        target: describeWorkspaceDomainTarget(entry.path),
      };
    }
    if (target.kind === 'node_summary') {
      return {
        targetKey: `node:${target.nodeId}`,
        target: describeWorkspaceDomainTarget(
          entry.path.replace(/\/summary\.md$/u, '/prose.md'),
        ),
      };
    }
    if (target.kind === 'element_summary') {
      return {
        targetKey: `element:${target.elementId}`,
        target: describeWorkspaceDomainTarget(
          entry.path.replace(/\/summary\.md$/u, '/body.md'),
        ),
      };
    }
    if (target.kind === 'storyline_summary') {
      return {
        targetKey: `storyline:${target.storylineId}`,
        target: describeWorkspaceDomainTarget(
          entry.path.replace(/\/summary\.md$/u, '/body.md'),
        ),
      };
    }
    throw new Error('Authored read progress requires a prose object or its summary.');
  })();
  return {
    ...identity,
    summary: input.summary ?? authoredObjectSummary(entry, projectId) ?? '',
    completeBodyRead: input.completeBodyRead,
    focusedBodyEdit: input.focusedBodyEdit,
    currentPassages: input.currentPassages,
  };
}

function resolveWorkspacePath(projectId: string, value: unknown): string {
  const normalized = normalizeVirtualPath(value);
  if (normalized === '/') return normalized;
  const collectionAlias = semanticCollectionPath(normalized);
  if (collectionAlias) return collectionAlias;
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
  const semanticChapterField = resolveSemanticChapterFieldAlias(entries, normalized);
  if (semanticChapterField && paths.has(semanticChapterField)) return semanticChapterField;
  const semanticAuthoredField = resolveSemanticAuthoredFieldAlias(entries, normalized);
  if (semanticAuthoredField && paths.has(semanticAuthoredField)) return semanticAuthoredField;
  const bareSummaryField = resolveBareAuthoredSummaryAlias(entries, normalized);
  if (bareSummaryField && paths.has(bareSummaryField)) return bareSummaryField;
  const semanticObject = resolveSemanticAuthoredObjectAlias(entries, normalized);
  if (semanticObject && paths.has(semanticObject)) return semanticObject;
  const bareAuthoredObject = resolveBareAuthoredObjectAlias(entries, normalized);
  if (bareAuthoredObject && paths.has(bareAuthoredObject)) return bareAuthoredObject;
  const semanticHandle = resolveSemanticHandleAlias(normalized);
  if (semanticHandle) return semanticHandle;
  const chapterAlias = resolveChapterOrdinalAlias(entries, normalized);
  if (chapterAlias && paths.has(chapterAlias)) return chapterAlias;
  const suffixMatches = [...paths].filter((path) => path.endsWith(normalized));
  return suffixMatches.length === 1 ? suffixMatches[0]! : normalized;
}

function resolveWorkspaceBrowseTarget(projectId: string, value: unknown): string {
  const normalized = normalizeVirtualPath(value);
  const category = /^\/?要素分类[「“"](.+?)[」”"]$/u.exec(normalized)?.[1]?.trim();
  if (category) {
    const candidate = `/elements/${pathSegment(category)}`;
    if (isEmptyElementCategoryDirectory(projectId, candidate)) return candidate;
    if (buildWorkspaceEntries(projectId).some((entry) => pathIsWithin(entry.path, candidate))) {
      return candidate;
    }
  }
  return resolveWorkspacePath(projectId, value);
}

function resolveWorkspaceCompleteObjectPath(projectId: string, value: unknown): string {
  const resolved = resolveWorkspacePath(projectId, value);
  const authoredLabel = String(value ?? '').trim();
  if (/(?:正文|摘要|标题|设定|别名|事实|分组|分类|说明|章节关系)$/u.test(authoredLabel)) {
    return resolved;
  }
  const entry =
    findWorkspaceEntry(projectId, resolved) ?? primaryWorkspaceEntry(projectId, resolved, false);
  return entry ? completeStructuralResourcePath(projectId, entry.target) ?? resolved : resolved;
}

function resolveBareAuthoredObjectAlias(
  entries: readonly WorkspaceEntry[],
  normalized: string,
): string | null {
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const name = decodePathSegment(segments[0] ?? '').trim();
  if (!name) return null;
  const state = useDataStore.getState();
  const candidates = entries.filter((entry) => {
    const target = entry.target;
    if (target.kind === 'element_body') {
      const element = state.bookElements.find((candidate) => candidate.id === target.elementId);
      const names = element ? allElementNames(element) : [target.elementName];
      return names.some((candidate) => authoredNamesEqual(candidate, name));
    }
    if (target.kind === 'storyline_body') {
      return authoredNamesEqual(target.storylineName, name);
    }
    if (target.kind === 'category_body') {
      return authoredNamesEqual(target.categoryName, name);
    }
    if (target.kind === 'material') {
      return authoredNamesEqual(target.materialTitle, name);
    }
    if (target.kind === 'node_prose') {
      return authoredNamesEqual(target.nodeName, name);
    }
    return false;
  });
  if (candidates.length !== 1) return null;
  return candidates[0]!.path.replace(/\/(?:body|prose)\.md$/u, '');
}

function resolveSemanticAuthoredObjectAlias(
  entries: readonly WorkspaceEntry[],
  normalized: string,
): string | null {
  const qualifiedElement = parseQualifiedElementTarget(normalized);
  if (qualifiedElement) {
    const state = useDataStore.getState();
    const candidates = entries.filter((entry) => {
      const target = entry.target;
      if (target.kind !== 'element_body') return false;
      const element = state.bookElements.find(
        (candidate) => candidate.id === target.elementId,
      );
      const category = state.bookElementCategories.find(
        (candidate) => candidate.id === element?.categoryId,
      );
      const names = element ? allElementNames(element) : [target.elementName];
      return (
        category !== undefined &&
        authoredNamesEqual(category.name, qualifiedElement.categoryName) &&
        names.some((candidate) => authoredNamesEqual(candidate, qualifiedElement.name))
      );
    });
    return candidates.length === 1
      ? candidates[0]!.path.replace(/\/(?:body|prose)\.md$/u, '')
      : null;
  }
  const match = /^\/?(故事线|要素分类|人物|角色|地点|区域|组织|势力|物品|道具|要素|素材)[「“"](.+?)[」”"]$/u.exec(
    normalized,
  );
  if (!match) return null;
  const kind = match[1]!;
  const name = match[2]!.trim();
  const state = useDataStore.getState();
  const candidates = entries.filter((entry) => {
    const target = entry.target;
    if (kind === '故事线') {
      return (
        target.kind === 'storyline_body' && authoredNamesEqual(target.storylineName, name)
      );
    }
    if (kind === '要素分类') {
      return target.kind === 'category_body' && authoredNamesEqual(target.categoryName, name);
    }
    if (kind === '素材') {
      return target.kind === 'material' && authoredNamesEqual(target.materialTitle, name);
    }
    if (target.kind !== 'element_body') return false;
    const element = state.bookElements.find((candidate) => candidate.id === target.elementId);
    const names = element ? allElementNames(element) : [target.elementName];
    return names.some((candidate) => authoredNamesEqual(candidate, name));
  });
  if (candidates.length !== 1) return null;
  return candidates[0]!.path.replace(/\/(?:body|prose)\.md$/u, '');
}

function resolveSemanticAuthoredFieldAlias(
  entries: readonly WorkspaceEntry[],
  normalized: string,
): string | null {
  const match = /^\/?(故事线|要素分类|人物|角色|地点|区域|组织|势力|物品|道具|要素)[「“"](.+?)[」”"](正文|设定|说明|摘要|名称|别名|事实|分组|分类|章节关系|章节|完整档案)$/u.exec(
    normalized,
  );
  if (!match) return null;
  const kind = match[1]!;
  const name = match[2]!.trim();
  const field = match[3]!;
  const state = useDataStore.getState();
  const targetKind = (() => {
    if (kind === '故事线') {
      return {
        正文: 'storyline_body',
        设定: 'storyline_body',
        说明: 'storyline_body',
        摘要: 'storyline_summary',
        名称: 'storyline_name',
        事实: 'storyline_facts',
        章节关系: 'storyline_chapters',
        章节: 'storyline_chapters',
        完整档案: 'storyline_meta',
      }[field];
    }
    if (kind === '要素分类') {
      return {
        正文: 'category_body',
        设定: 'category_body',
        说明: 'category_body',
        完整档案: 'category_meta',
      }[field];
    }
    return {
      正文: 'element_body',
      设定: 'element_body',
      说明: 'element_body',
      摘要: 'element_summary',
      名称: 'element_name',
      别名: 'element_aliases',
      事实: 'element_facts',
      分组: 'element_group',
      分类: 'element_category',
      完整档案: 'element_meta',
    }[field];
  })();
  if (!targetKind) return null;
  const candidates = entries.filter((entry) => {
    const target = entry.target;
    if (target.kind !== targetKind) return false;
    if (isElementTarget(target)) {
      const element = state.bookElements.find(
        (candidate) => candidate.id === target.elementId,
      );
      const names = element ? allElementNames(element) : [target.elementName];
      return names.some((candidate) => authoredNamesEqual(candidate, name));
    }
    if (isStorylineTarget(target)) {
      return authoredNamesEqual(target.storylineName, name);
    }
    if (isCategoryTarget(target)) {
      return authoredNamesEqual(target.categoryName, name);
    }
    return false;
  });
  return candidates.length === 1 ? candidates[0]!.path : null;
}

function resolveBareAuthoredSummaryAlias(
  entries: readonly WorkspaceEntry[],
  normalized: string,
): string | null {
  const label = decodePathSegment(normalized.replace(/^\/+/, '')).trim();
  const match = /^(?:[「“"](.+?)[」”"]|(.+?))\s*摘要$/u.exec(label);
  const name = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!name) return null;
  const base = resolveBareAuthoredObjectAlias(entries, normalizeVirtualPath(name));
  if (!base) return null;
  const summaryPath = `${base}/summary.md`;
  return entries.some((entry) => entry.path === summaryPath) ? summaryPath : null;
}

function resolveSemanticHandleAlias(value: string): string | null {
  const match = /^\/?(批注或待办|批注|待办|实体关系|关系|作者规则|写作规则)[「“"](.+?)[」”"]$/u.exec(
    value,
  );
  if (!match) return null;
  const root = /批注|待办/u.test(match[1]!)
    ? 'comments'
    : /关系/u.test(match[1]!)
      ? 'relations'
      : 'memory';
  return `/${root}/${pathSegment(match[2]!.trim())}.json`;
}

function missingAuthoredTargetMessage(projectId: string, value: unknown): string | null {
  const normalized = normalizeVirtualPath(value);
  const semantic = /^\/?(故事线|要素分类|人物|角色|地点|区域|组织|势力|物品|道具|要素|素材)[「“"](.+?)[」”"](?:正文|设定|说明|摘要|名称|别名|事实|分组|分类|章节关系|章节|完整档案)?$/u.exec(
    normalized,
  );
  if (semantic) {
    const kind = semantic[1]!;
    const name = semantic[2]!.trim();
    return `${kind}「${name}」尚未建立。当前任务需要它时可以直接创建；无需继续尝试这个名称的其他写法。`;
  }
  const segments = normalized.split('/').filter(Boolean);
  const referenceIndex = segments[0] === 'chapters' ? 1 : 0;
  const rawReference = segments[referenceIndex];
  if (!rawReference) return null;
  const decoded = decodePathSegment(rawReference).trim();
  const withoutField = decoded.replace(/\s*(正文|摘要|标题)$/u, '').trim();
  if (parseChapterOrdinal(withoutField) === null) return null;

  void projectId;
  return (
    `${withoutField}尚未创建。` +
    `如果当前任务包含它，可以直接按作者已有素材写出正文并同时建立摘要。`
  );
}

function authoredQueryExcerpt(content: string, query: string): string {
  const text = projectAuthoredTextForModel(content).text;
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (at < 0) return '';
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const paragraphEnd = text.indexOf('\n\n', at + query.length);
  const end = paragraphEnd < 0 ? text.length : paragraphEnd;
  return text.slice(lineStart, end).trim();
}

function missingAuthoredTargetQuery(value: unknown): string | null {
  const normalized = normalizeVirtualPath(value);
  const semantic = /^\/?(?:故事线|要素分类|人物|角色|地点|区域|组织|势力|物品|道具|要素|素材)[「“"](.+?)[」”"](?:正文|设定|说明|摘要|名称|别名|事实|分组|分类|章节关系|章节|完整档案)?$/u.exec(
    normalized,
  );
  if (semantic?.[1]?.trim()) return semantic[1].trim();
  const segments = normalized.split('/').filter(Boolean);
  const referenceIndex = segments[0] === 'chapters' ? 1 : 0;
  const rawReference = segments[referenceIndex];
  if (!rawReference) return null;
  const reference = decodePathSegment(rawReference)
    .replace(/\s*(正文|摘要|标题)$/u, '')
    .trim();
  return parseChapterOrdinal(reference) === null ? null : reference;
}

function authoredNamesEqual(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, '');
  const normalizedLeft = normalize(left);
  return normalizedLeft.length > 0 && normalizedLeft === normalize(right);
}

function resolveSemanticChapterFieldAlias(
  entries: readonly WorkspaceEntry[],
  normalized: string,
): string | null {
  const match = /^\/?(章节|灵感|漂移)[「“"](.+?)[」”"](正文|摘要|标题)?$/u.exec(
    normalized,
  );
  if (!match) return null;
  const nodeKind = match[1] === '章节' ? 'chapter' : 'drift';
  const name = match[2]!.trim();
  const matches = entries.filter((entry) => {
    const target = entry.target;
    return (
      isNodeTarget(target) &&
      target.kind === 'node_prose' &&
      target.nodeKind === nodeKind &&
      target.nodeName.trim() === name
    );
  });
  if (matches.length !== 1) return null;
  const base = matches[0]!.path.replace(/\/prose\.md$/u, '');
  const file =
    match[3] === '摘要' ? 'summary.md' : match[3] === '标题' ? 'title.txt' : 'prose.md';
  return `${base}/${file}`;
}

function semanticCollectionPath(path: string): string | null {
  const aliases: Record<string, string> = {
    '/作品': '/',
    '/章节': '/chapters',
    '/灵感': '/drifts',
    '/漂移': '/drifts',
    '/元素': '/elements',
    '/要素': '/elements',
    '/实体': '/elements',
    '/故事线': '/storylines',
    '/要素分类': '/categories',
    '/素材': '/materials',
    '/参考素材': '/materials',
    '/项目信息': '/project',
    '/作品说明': '/README.md',
    '/项目事实': '/project/facts.json',
    '/项目设定': '/project/facts.json',
    '/批注': '/comments',
    '/待办': '/comments',
    '/批注或待办': '/comments',
    '/关系': '/relations',
    '/实体关系': '/relations',
    '/作者规则': '/memory',
    '/写作规则': '/memory',
    '/项目规则': '/memory',
  };
  return aliases[path] ?? null;
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

function entityAliases(
  state: ReturnType<typeof useDataStore.getState>,
  kind: string,
  id: string,
): string[] {
  if (kind !== 'element') return [];
  const element = state.bookElements.find((item) => item.id === id);
  return element ? elementAliases(element) : [];
}

function entityAuthoredDisplayName(
  state: ReturnType<typeof useDataStore.getState>,
  kind: string,
  id: string,
): string {
  const name = entityDisplayName(state, kind, id);
  const aliases = entityAliases(state, kind, id);
  return aliases.length > 0 ? `${name}（别名：${aliases.join('、')}）` : name;
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

function describeCommentForAuthor(
  state: ReturnType<typeof useDataStore.getState>,
  comment: Comment,
): string {
  const kind =
    comment.kind === 'todo' ? '待办' : comment.kind === 'exception' ? '例外说明' : '批注';
  const status =
    comment.status === 'open'
      ? '未完成'
      : comment.status === 'resolved'
        ? '已解决'
        : '已转化';
  const target =
    comment.targetKind && comment.targetId
      ? entityDisplayName(state, comment.targetKind, comment.targetId)
      : '';
  const body = extractTextFromCommentBody(comment.bodyJson);
  const quote = commentAnchorExcerpt(comment.anchorJson);
  return [kind, status, target, body, quote ? `引用片段：${quote}` : '']
    .filter(Boolean)
    .map((part) => compactDescription(part, 240))
    .join(' · ');
}

function commentAnchorExcerpt(anchorJson: string): string {
  try {
    const anchor = asRecord(JSON.parse(anchorJson));
    const selected =
      typeof anchor.selectedText === 'string'
        ? anchor.selectedText
        : typeof anchor.blockText === 'string'
          ? anchor.blockText
          : '';
    return selected.replace(/\s+/gu, ' ').trim();
  } catch {
    return '';
  }
}

function describeRelationForAuthor(
  state: ReturnType<typeof useDataStore.getState>,
  relation: EntityRelationLink,
): string {
  const from = entityAuthoredDisplayName(state, relation.fromKind, relation.fromId);
  const to = entityAuthoredDisplayName(state, relation.toKind, relation.toId);
  return `${from} —${relation.kind?.trim() || '关联'}→ ${to}`;
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
  const rawReference = segments[referenceIndex];
  const naturalField = rawReference
    ? /^(.*?)(正文|摘要|标题)$/u.exec(decodePathSegment(rawReference))
    : null;
  const reference = naturalField?.[1] || rawReference;
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
  const projectUsesNumericChapterTitles = entries.some((entry) => {
    const target = entry.target;
    return (
      isNodeTarget(target) &&
      target.kind === 'node_prose' &&
      target.nodeKind === 'chapter' &&
      /^\d+$/u.test(target.nodeName.trim())
    );
  });
  // Numeric-titled manuscripts use that title as their authored chapter
  // identity. Falling back to layout order when one number is absent can map
  // "第十六章" onto an unrelated earlier chapter whose bookOrder happens
  // to be 16. Order aliases remain available only for projects whose chapter
  // titles are non-numeric.
  const matches = projectUsesNumericChapterTitles ? numericTitleMatches : orderMatches;
  if (matches.length !== 1) return null;
  const base = matches[0]!.path.replace(/\/prose\.md$/, '');
  const remainder = segments.slice(referenceIndex + 1);
  if (remainder.length > 0) return `${base}/${remainder.join('/')}`;
  const naturalFile =
    naturalField?.[2] === '正文'
      ? 'prose.md'
      : naturalField?.[2] === '摘要'
        ? 'summary.md'
        : naturalField?.[2] === '标题'
          ? 'title.txt'
          : null;
  return naturalFile ? `${base}/${naturalFile}` : base;
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

function isWorkspaceNoopPreparationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === 'The requested replacements do not change the file' ||
    /^".*" already has the requested contents$/u.test(error.message)
  );
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
