import type { AgentChatMessage } from '../../domain/agent-conversation';
import type { AgentMessageBlock } from './useAgentMessageBlocks';

type UsageMessage = Extract<AgentChatMessage, { kind: 'usage' }>;
type ToolMessage = Extract<AgentChatMessage, { kind: 'tool' }>;
export interface AgentSessionUsage { readonly inTok: number; readonly outTok: number; readonly cost: number; readonly tools: number }
interface BlockContent { readonly usage: readonly UsageMessage[]; readonly tools: number; readonly successfulTools: readonly ToolMessage[] }
interface BlockSummary { readonly block: AgentMessageBlock; readonly content: BlockContent; readonly before: AgentSessionUsage; readonly after: AgentSessionUsage }
export interface AgentTranscriptSummary { readonly usage: AgentSessionUsage; readonly successfulTools: Iterable<ToolMessage> }
const emptyUsage: AgentSessionUsage = { inTok: 0, outTok: 0, cost: 0, tools: 0 };

function sameUsage(a: AgentSessionUsage, b: AgentSessionUsage): boolean {
  return Object.is(a.inTok, b.inTok) && Object.is(a.outTok, b.outTok) && Object.is(a.cost, b.cost) && Object.is(a.tools, b.tools);
}
function classify(block: AgentMessageBlock): BlockContent {
  const usage: UsageMessage[] = []; const successfulTools: ToolMessage[] = []; let tools = 0;
  for (const message of block.messages) {
    if (message.kind === 'usage') usage.push(message);
    else if (message.kind === 'tool') { tools++; if (message.status === 'ok') successfulTools.push(message); }
  }
  return { usage, tools, successfulTools };
}
function accumulate(before: AgentSessionUsage, content: BlockContent): AgentSessionUsage {
  if (!content.usage.length && !content.tools) return before;
  let { inTok, outTok, cost, tools } = before;
  // Retain the original left-to-right arithmetic; summing block subtotals would
  // regroup floating-point additions and can change the displayed cost.
  for (const message of content.usage) {
    inTok += message.inputTokens + message.cacheReadTokens + message.cacheCreationTokens;
    outTok += message.outputTokens;
    cost += message.costUsd;
  }
  tools += content.tools;
  return { inTok, outTok, cost, tools };
}

/** One mounted view's latest block projection. Cached values contain message
 * facts only, never workspace-dependent entity resolution or durable authority.
 * Old results remain immutable; no entry points at an earlier projection. */
export function createAgentTranscriptSummary() {
  let source: readonly AgentMessageBlock[] | undefined;
  let entries: readonly BlockSummary[] = [];
  let result: AgentTranscriptSummary | undefined;
  return (blocks: readonly AgentMessageBlock[]): AgentTranscriptSummary => {
    if (source === blocks && result) return result;
    const next: BlockSummary[] = []; let total = emptyUsage;
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]; const previous = entries[index];
      if (previous?.block === block && sameUsage(total, previous.before)) {
        next.push(previous); total = previous.after;
      } else {
        const content = previous?.block === block ? previous.content : classify(block);
        const after = accumulate(total, content);
        next.push({ block, content, before: total, after }); total = after;
      }
    }
    const usage = result && sameUsage(result.usage, total) ? result.usage : total;
    source = blocks; entries = next;
    result = { usage, successfulTools: { *[Symbol.iterator]() {
      for (const entry of next) yield* entry.content.successfulTools;
    } } };
    return result;
  };
}
