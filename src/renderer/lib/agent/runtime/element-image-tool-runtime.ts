import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { composeImagePrompt } from '../../../domain/material-provenance';
import type {
  CodexImagesGenerateInput,
  ImageGenerationResult,
  ImageInboxEntry,
  ImageQuotaSnapshot,
} from '../../../platform';
import {
  DEFAULT_ELEMENT_IMAGE_COUNT,
  ELEMENT_IMAGE_TOOL_NAME,
  MAX_ELEMENT_IMAGE_COUNT,
  isElementImageConversation,
  readElementImageRequest,
} from '../element-image-requests';
import { isAgentAbort, throwIfAgentAborted } from './errors';
import type {
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
  AgentToolPermissionPolicy,
  AgentToolRuntime,
} from './types';

export { ELEMENT_IMAGE_TOOL_NAME } from '../element-image-requests';

/** Mirrors the native host's prompt ceiling (`codex_images.rs`). */
const MAX_SENT_PROMPT_CHARS = 8_000;

const generateSchema = Type.Object(
  {
    elementId: Type.String({
      minLength: 1,
      maxLength: 128,
      description: 'Opaque element id given by the task or a read tool; not a name',
    }),
    prompt: Type.String({
      minLength: 1,
      maxLength: 6_000,
      description:
        'Concrete image description: subject, appearance, setting, composition and mood; a project art style is appended when set',
    }),
    count: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_ELEMENT_IMAGE_COUNT,
        description: "Number of candidates; defaults to the author's request or 2",
      }),
    ),
  },
  { additionalProperties: false },
);

function validate(value: unknown) {
  return Value.Check(generateSchema, value)
    ? { ok: true as const, value: value as Record<string, unknown> }
    : {
        ok: false as const,
        error: [...Value.Errors(generateSchema, value)][0]?.message ?? 'Invalid input',
      };
}

function routeProjectId(context: AgentRuntimeContext): string | null {
  return context.route.kind === 'test'
    ? (context.route.projectId ?? null)
    : context.route.projectId;
}

function routeConversationId(context: AgentRuntimeContext): string | null {
  return context.route.kind === 'chat' ? (context.route.conversationId ?? null) : null;
}

function quotaLine(quota: ImageQuotaSnapshot | null): string | null {
  if (quota?.usedPercent == null) return null;
  const resets = quota.resetsAtMs ? `, resets ${new Date(quota.resetsAtMs).toISOString()}` : '';
  return `Image limit used: ${quota.usedPercent}%${resets}.`;
}

export interface ElementImageToolRuntimeOptions {
  generate: (
    input: Omit<CodexImagesGenerateInput, 'requestId'>,
    signal: AbortSignal,
  ) => Promise<ImageGenerationResult>;
  /** The live, non-deleted element in this project, or null. */
  resolveElement: (projectId: string, elementId: string) => { id: string; name: string } | null;
  /** The project art style fact; empty when unset. */
  getArtStyle: (projectId: string) => string;
  onCandidates: (
    projectId: string,
    candidates: ImageInboxEntry[],
    quota: ImageQuotaSnapshot | null,
  ) => void;
}

/**
 * `generate_element_images`: generates concept image candidates into the
 * device-local inbox through the ChatGPT subscription. It writes no project
 * data, so it runs outside the shared write barrier and keeps no receipt; the
 * candidates reach the element page through `onCandidates`, and the model only
 * sees a short summary.
 */
export class AgentElementImageToolRuntime implements AgentToolRuntime {
  constructor(private readonly options: ElementImageToolRuntimeOptions) {}

  listDefinitions(): readonly AgentToolDefinition[] {
    return [
      {
        name: ELEMENT_IMAGE_TOOL_NAME,
        description:
          "Generate concept image candidates for one story element (a person, place, object, group, phenomenon or idea) with the author's ChatGPT subscription. Candidates go to the element page for the author to choose; nothing in the project changes. Describe the image concretely; a project art style, when set, is appended, so do not repeat it. Spends the author's image quota.",
        inputSchema: generateSchema,
        access: 'write',
        scheduling: 'independent',
        validateInput: (input) => validate(input),
      },
    ];
  }

  async execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult> {
    throwIfAgentAborted(request.signal);
    if (request.name !== ELEMENT_IMAGE_TOOL_NAME) {
      return { ok: false, error: `Unknown element image tool "${request.name}".` };
    }
    const projectId = routeProjectId(request.context);
    if (!projectId) {
      return { ok: false, error: 'Element image generation requires a project-owned route.' };
    }
    const elementId = String(request.arguments.elementId);
    const element = this.options.resolveElement(projectId, elementId);
    if (!element) {
      return {
        ok: false,
        error: `ELEMENT_NOT_FOUND: no element has id "${elementId}" in this project; use the id from the task or read_element.`,
      };
    }
    const authorRequest = readElementImageRequest(element.id);
    const count =
      (request.arguments.count as number | undefined) ??
      authorRequest?.count ??
      DEFAULT_ELEMENT_IMAGE_COUNT;
    const subjectPrompt = String(request.arguments.prompt).trim();
    const styleText = this.options.getArtStyle(projectId).trim() || null;
    const prompt = composeImagePrompt(subjectPrompt, styleText);
    if (prompt.length > MAX_SENT_PROMPT_CHARS) {
      return {
        ok: false,
        error: `PROMPT_TOO_LONG: the description plus the project art style must stay within ${MAX_SENT_PROMPT_CHARS} characters.`,
      };
    }
    try {
      const result = await this.options.generate(
        {
          projectId,
          target: { kind: 'element', id: element.id },
          prompt,
          count,
          provenance: {
            subjectPrompt,
            styleText,
            extraPrompt: authorRequest?.extraPrompt ?? null,
            conversationId: routeConversationId(request.context),
          },
        },
        request.signal,
      );
      // The files already exist; surface them even if the turn is stopping.
      this.options.onCandidates(projectId, result.candidates, result.quota);
      const lines = [
        `Generated ${result.candidates.length} image candidate(s) for element "${element.name}". They are in the element page's candidate strip; the author chooses what to keep.`,
      ];
      if (result.failures.length > 0) {
        lines.push(`${result.failures.length} request(s) failed: ${result.failures.join('; ')}`);
      }
      const quota = quotaLine(result.quota);
      if (quota) lines.push(quota);
      return {
        ok: true,
        data: {
          candidateIds: result.candidates.map((candidate) => candidate.id),
          failures: result.failures,
          quota: result.quota,
        },
        modelData: lines.join('\n'),
      };
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Element image generation failed.',
      };
    }
  }
}

export function resolveAgentElementImageToolAccess(name: string): 'write' | undefined {
  return name === ELEMENT_IMAGE_TOOL_NAME ? 'write' : undefined;
}

/**
 * The tool runs without a prompt only in a conversation the element page
 * started for it; anywhere else spending the author's image quota asks first.
 */
export function createElementImageAwarePermissionPolicy(
  fallback: AgentToolPermissionPolicy,
  isPageConversation: (conversationId: string | null) => boolean = isElementImageConversation,
): AgentToolPermissionPolicy {
  return {
    async decide(request) {
      if (request.toolName !== ELEMENT_IMAGE_TOOL_NAME) return fallback.decide(request);
      if (request.access !== 'write') {
        return { decision: 'deny', reason: 'Element image tool access changed.' };
      }
      if (isPageConversation(routeConversationId(request.context))) {
        return { decision: 'allow', scope: 'once' };
      }
      return {
        decision: 'ask',
        reason: "Generating images spends the author's ChatGPT image quota.",
        allowedScopes: ['once'],
      };
    },
  };
}
