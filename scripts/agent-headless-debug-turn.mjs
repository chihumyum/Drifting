#!/usr/bin/env node

const DEFAULT_URL = 'http://127.0.0.1:4317';

function parseArgs(argv) {
  const options = {
    url: process.env.DRIFTING_AGENT_DEBUG_URL || DEFAULT_URL,
    timeoutMs: 600_000,
    permissionMode: 'manual',
    userInputs: [],
    raw: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--project') options.projectId = next();
    else if (arg === '--prompt') options.prompt = next();
    else if (arg === '--prompt-file') options.promptFile = next();
    else if (arg === '--conversation') options.conversationId = next();
    else if (arg === '--url') options.url = next();
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--permission') options.permissionMode = next();
    else if (arg === '--edit-mode') options.editMode = next();
    else if (arg === '--thinking') options.thinking = next();
    else if (arg === '--effort') options.effort = next();
    else if (arg === '--show-thinking') options.showThinking = true;
    else if (arg === '--answer') options.userInputs.push(next());
    else if (arg === '--auto-continue') options.autoContinue = true;
    else if (arg === '--raw') options.raw = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  pnpm agent:debug:turn -- --project <id> --prompt <text> [options]',
    '',
    'Options:',
    '  --prompt-file <path>            Read the prompt from a UTF-8 file',
    '  --conversation <id>             Resume an existing Agent conversation',
    '  --permission manual|allow_once|deny',
    '  --edit-mode auto|approve         Override review mode for this turn only',
    '  --thinking adaptive|off          Override reasoning mode for this turn only',
    '  --effort low|medium|high|xhigh|max  Override reasoning effort for this turn only',
    '  --show-thinking                  Print each complete model reasoning pass',
    '  --answer <text>                  Queued answer for ask_user (repeatable)',
    '  --auto-continue                  Follow durable-task steps until a stable stop',
    '  --timeout-ms <ms>                1000..43200000 (default 600000)',
    '  --raw                            Print every NDJSON object',
    '  --url <http://127.0.0.1:4317>   Broker URL',
  ].join('\n');
}

function truncate(value, max = 800) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;
}

const THINKING_MECHANICS =
  /\b(?:JSON|Yjs|SQLite|TipTap|ProseMirror|callId|taskId|stepId|schema|serialization|escaping|expectedRevision|receipt|transport|storage)\b|\b(?:list_files|read_file|grep|edit_file|write_file|delete_file)\b|\b(?:file|directory|filesystem|virtual path)\b|\b(?:tool|function) (?:call|name|argument|schema)\b|\brevision (?:id|token|number|receipt)\b|\/(?:chapters|drifts|elements|storylines|categories|comments|relations|memory|project)\/|\.(?:md|json|txt)\b|虚拟路径|文件路径|文件系统|目录|版本号|序列化|转义|数据库|持久化|工具参数|工具调用/giu;
const THINKING_REREAD =
  /\b(?:re-?read|read (?:all|each|the) .* again|fresh reads?|read .* fully)\b|重新(?:通读|读取|读)|再(?:通读|读取|读)(?:一遍|一次)?|重新确认正文/giu;
const THINKING_RUNTIME_META =
  /\b(?:compaction|compacted|context continuity|system messages?|earlier (?:agent activity|session|turns?)|previous (?:session|turn)|tool results?|write (?:succeeded|failed)|provider summary)\b|压缩(?:上下文)?|恢复上下文|系统消息|较早轮次|工具结果|写入(?:成功|失败)/giu;
const THINKING_CHARACTER_MATCH =
  /\b(?:character[- ]by[- ]character|closing quote|quote characters?|newlines?|blank lines?|exact text|oldText|newText|fragment (?:match|matching)|match fail(?:ed|ure)?|why did .* match fail)\b|逐字符|引号|换行|空行|精确文本|片段匹配|匹配失败/giu;
const OVERSIZED_THINKING_CHARACTERS = 8_000;

function auditExamples(text, matches, target) {
  for (const match of matches) {
    if (target.length >= 3) break;
    const at = match.index ?? text.indexOf(match[0]);
    const start = Math.max(0, at - 80);
    const end = Math.min(text.length, at + match[0].length + 80);
    const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (excerpt && !target.includes(excerpt)) target.push(excerpt);
  }
}

function auditThinking(state, iteration, value) {
  const text = value.trim();
  if (!text) return;
  const mechanics = text.match(THINKING_MECHANICS) ?? [];
  const rereads = text.match(THINKING_REREAD) ?? [];
  const runtimeMeta = [...text.matchAll(THINKING_RUNTIME_META)];
  const characterMatch = [...text.matchAll(THINKING_CHARACTER_MATCH)];
  const characters = [...text].length;
  state.thinkingAudit.passes += 1;
  state.thinkingAudit.characters += characters;
  state.thinkingAudit.longestCharacters = Math.max(
    state.thinkingAudit.longestCharacters,
    characters,
  );
  state.thinkingAudit.mechanicsHits += mechanics.length;
  state.thinkingAudit.rereadIntentHits += rereads.length;
  state.thinkingAudit.runtimeMetaHits += runtimeMeta.length;
  state.thinkingAudit.characterMatchHits += characterMatch.length;
  auditExamples(text, runtimeMeta, state.thinkingAudit.runtimeMetaExamples);
  auditExamples(text, characterMatch, state.thinkingAudit.characterMatchExamples);
  for (const match of mechanics) state.thinkingAudit.mechanicsTerms.add(match.toLowerCase());
  state.thinkingAudit.iterations.push(iteration);
  if (characters > OVERSIZED_THINKING_CHARACTERS) {
    state.thinkingAudit.oversizedIterations.push(iteration);
  }
}

function normalizedAuthoredTarget(arguments_) {
  if (!arguments_ || typeof arguments_ !== 'object') return '';
  const target = typeof arguments_.target === 'string' ? arguments_.target : '';
  return target
    .normalize('NFKC')
    .replace(/([」”"])\s*[（(]别名[：:][^）)]*[）)]/gu, '$1')
    .replace(/(?:正文|设定|说明)$/u, '')
    .replace(/\s+/gu, '')
    .trim();
}

function auditDomainToolCall(state, event) {
  const name = event.name;
  const isRead = name === 'read_object';
  const isSearch = name === 'search_work';
  const isBrowse = name === 'browse_project';
  const isMutation =
    name === 'write_object' || name === 'revise_object' || name === 'delete_object';
  if (isRead) state.domainAudit.readCalls += 1;
  if (isSearch) state.domainAudit.searchCalls += 1;
  if (isBrowse) state.domainAudit.browseCalls += 1;
  if (isMutation) {
    state.domainAudit.mutationCalls += 1;
    state.domainAudit.firstMutationSeen = true;
    state.domainAudit.maxDiscoveryStreak = Math.max(
      state.domainAudit.maxDiscoveryStreak,
      state.domainAudit.currentDiscoveryStreak,
    );
    state.domainAudit.currentDiscoveryStreak = 0;
    const target = normalizedAuthoredTarget(event.arguments);
    if (target) state.domainAudit.mutatedTargets.add(target);
    return;
  }
  if (isRead || isSearch || isBrowse) {
    state.domainAudit.currentDiscoveryStreak += 1;
    if (!state.domainAudit.firstMutationSeen) {
      state.domainAudit.discoveryCallsBeforeFirstMutation += 1;
    }
  }
  if (isRead) {
    const target = normalizedAuthoredTarget(event.arguments);
    if (target && state.domainAudit.mutatedTargets.has(target)) {
      state.domainAudit.postMutationRereads += 1;
    }
  }
}

function printAudit(state) {
  if (!state.showThinking || state.auditPrinted) return;
  state.auditPrinted = true;
  const duplicateCalls = [...state.toolCallCounts.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  console.log(
    `[thinking-audit] passes=${state.thinkingAudit.passes} ` +
      `chars=${state.thinkingAudit.characters} ` +
      `longest=${state.thinkingAudit.longestCharacters} ` +
      `mechanics_hits=${state.thinkingAudit.mechanicsHits} ` +
      `runtime_meta_hits=${state.thinkingAudit.runtimeMetaHits} ` +
      `character_match_hits=${state.thinkingAudit.characterMatchHits} ` +
      `reread_intent_hits=${state.thinkingAudit.rereadIntentHits} ` +
      `oversized_passes=${state.thinkingAudit.oversizedIterations.length} ` +
      `duplicate_tool_calls=${duplicateCalls}`,
  );
  if (state.thinkingAudit.mechanicsTerms.size > 0) {
    console.log(
      `[thinking-audit mechanics] ${[...state.thinkingAudit.mechanicsTerms].sort().join(', ')}`,
    );
  }
  for (const excerpt of state.thinkingAudit.runtimeMetaExamples) {
    console.log(`[thinking-audit runtime-example] ${excerpt}`);
  }
  for (const excerpt of state.thinkingAudit.characterMatchExamples) {
    console.log(`[thinking-audit character-example] ${excerpt}`);
  }
  if (state.thinkingAudit.oversizedIterations.length > 0) {
    console.log(
      `[thinking-audit oversized] threshold=${OVERSIZED_THINKING_CHARACTERS} ` +
        `iterations=${state.thinkingAudit.oversizedIterations.join(',')}`,
    );
  }
  state.domainAudit.maxDiscoveryStreak = Math.max(
    state.domainAudit.maxDiscoveryStreak,
    state.domainAudit.currentDiscoveryStreak,
  );
  console.log(
    `[domain-audit] browse_calls=${state.domainAudit.browseCalls} ` +
      `read_calls=${state.domainAudit.readCalls} ` +
      `search_calls=${state.domainAudit.searchCalls} ` +
      `mutation_calls=${state.domainAudit.mutationCalls} ` +
      `discovery_before_first_mutation=${state.domainAudit.discoveryCallsBeforeFirstMutation} ` +
      `max_discovery_streak=${state.domainAudit.maxDiscoveryStreak} ` +
      `post_mutation_rereads=${state.domainAudit.postMutationRereads}`,
  );
}

function flushThinking(state, iteration) {
  if (!state.showThinking) return;
  const iterations = iteration === undefined
    ? [...state.thinkingByIteration.keys()].sort((left, right) => left - right)
    : [iteration];
  for (const current of iterations) {
    const text = state.thinkingByIteration.get(current)?.trim();
    if (!text) continue;
    auditThinking(state, current, text);
    console.log(`\n[thinking ${current}]`);
    console.log(text);
    state.thinkingByIteration.delete(current);
  }
}

function printEvent(payload, state) {
  if (payload.type === 'queued') {
    console.log(`[queued] ${payload.requestId}`);
    return;
  }
  if (payload.type === 'bridge_started') {
    console.log(
      `[bridge] project=${payload.projectId}` +
        `${payload.thinking ? ` thinking=${payload.thinking}` : ''}` +
        `${payload.effort ? ` effort=${payload.effort}` : ''}`,
    );
    return;
  }
  if (payload.type === 'bridge_completed') {
    flushThinking(state);
    printAudit(state);
    console.log('\n[assistant]');
    console.log(payload.assistantText || '(empty)');
    console.log(
      `\n[completed] outcome=${payload.outcome} session=${payload.sessionId} ` +
        `turn=${payload.turnId} slices=${payload.turnIds?.length ?? 1} ` +
        `conversation=${payload.conversationId}`,
    );
    if (payload.automaticContinuation) {
      console.log(
        `[auto] status=${payload.automaticContinuation.status} ` +
          `started=${payload.automaticContinuation.automaticSlicesStarted} ` +
          `reason=${payload.automaticContinuation.stopReason ?? 'none'}`,
      );
      if (
        ['start_failed', 'turn_failed', 'plan_unavailable'].includes(
          payload.automaticContinuation.stopReason,
        )
      ) {
        state.failed = true;
      }
    }
    return;
  }
  if (payload.type === 'bridge_failed' || payload.type === 'broker_error') {
    flushThinking(state);
    printAudit(state);
    console.error(`[failed] ${payload.error}`);
    state.failed = true;
    return;
  }
  if (payload.type !== 'journal') return;
  const event = payload.entry?.event;
  if (!event) return;
  switch (event.type) {
    case 'thinking_delta':
      if (state.showThinking) {
        state.thinkingByIteration.set(
          event.iteration,
          (state.thinkingByIteration.get(event.iteration) ?? '') + event.text,
        );
      }
      break;
    case 'tool_call_ready':
      flushThinking(state, event.iteration);
      auditDomainToolCall(state, event);
      {
        const signature = `${event.name}:${JSON.stringify(event.arguments)}`;
        state.toolCallCounts.set(signature, (state.toolCallCounts.get(signature) ?? 0) + 1);
      }
      console.log(`[tool ->] ${event.name} ${truncate(event.arguments)}`);
      break;
    case 'tool_result':
      console.log(
        `[tool <-] ${event.name} ${event.ok ? 'ok' : 'error'}` +
          `${event.review?.id ? ` review=${event.review.id}` : ''} ${truncate(event.content)}`,
      );
      break;
    case 'context_planned':
      console.log(
        `[context] ${event.snapshot.estimatedInputTokens}/${event.snapshot.contextWindowTokens} ` +
          `free=${event.snapshot.freeTokens} ` +
          `compaction=${event.snapshot.compaction.stages.join(',') || 'none'}`,
      );
      break;
    case 'model_usage':
      flushThinking(state, event.iteration);
      console.log(
        `[usage] iteration=${event.iteration} input=${event.usage.inputTokens} ` +
          `output=${event.usage.outputTokens}`,
      );
      break;
    case 'permission_requested':
      console.log(`[permission] ${event.request.toolName} mode=${state.permissionMode}`);
      break;
    case 'user_input_requested':
      console.log(`[ask_user] ${event.request.prompt}`);
      break;
    case 'turn_finished':
      flushThinking(state);
      console.log(
        `[turn] ${event.outcome} iterations=${event.modelIterations} ` +
          `duration=${event.durationMs}ms${event.failureCode ? ` code=${event.failureCode}` : ''}`,
      );
      if (
        event.outcome !== 'completed' &&
        !(state.autoContinue && event.outcome === 'budget_exceeded')
      ) {
        state.failed = true;
      }
      break;
    default:
      break;
  }
}

async function readPrompt(options) {
  if (options.prompt && options.promptFile) {
    throw new Error('Use either --prompt or --prompt-file, not both');
  }
  if (options.promptFile) {
    const { readFile } = await import('node:fs/promises');
    return readFile(options.promptFile, 'utf8');
  }
  return options.prompt;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const prompt = await readPrompt(options);
  if (!options.projectId || !prompt?.trim()) throw new Error('--project and a prompt are required');
  if (options.editMode && options.editMode !== 'auto' && options.editMode !== 'approve') {
    throw new Error('--edit-mode must be auto or approve');
  }
  if (options.thinking && options.thinking !== 'adaptive' && options.thinking !== 'off') {
    throw new Error('--thinking must be adaptive or off');
  }
  if (
    options.effort &&
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)
  ) {
    throw new Error('--effort must be low, medium, high, xhigh, or max');
  }
  const state = {
    failed: false,
    permissionMode: options.permissionMode,
    autoContinue: options.autoContinue === true,
    showThinking: options.showThinking === true,
    thinkingByIteration: new Map(),
    thinkingAudit: {
      passes: 0,
      characters: 0,
      longestCharacters: 0,
      mechanicsHits: 0,
      runtimeMetaHits: 0,
      characterMatchHits: 0,
      rereadIntentHits: 0,
      mechanicsTerms: new Set(),
      runtimeMetaExamples: [],
      characterMatchExamples: [],
      iterations: [],
      oversizedIterations: [],
    },
    domainAudit: {
      browseCalls: 0,
      readCalls: 0,
      searchCalls: 0,
      mutationCalls: 0,
      discoveryCallsBeforeFirstMutation: 0,
      currentDiscoveryStreak: 0,
      maxDiscoveryStreak: 0,
      postMutationRereads: 0,
      firstMutationSeen: false,
      mutatedTargets: new Set(),
    },
    toolCallCounts: new Map(),
    auditPrinted: false,
  };
  const onTermination = (signal) => {
    flushThinking(state);
    printAudit(state);
    console.error(
      `[aborted] debug client received ${signal}; the renderer will cancel the active turn`,
    );
    process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
  };
  const terminationHandlers = new Map(
    ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
      const handler = () => onTermination(signal);
      process.once(signal, handler);
      return [signal, handler];
    }),
  );
  try {
    const response = await fetch(new URL('/turn', options.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: options.projectId,
        prompt,
        timeoutMs: options.timeoutMs,
        permissionMode: options.permissionMode,
        autoContinue: options.autoContinue === true,
        ...(options.editMode ? { editMode: options.editMode } : {}),
        ...(options.thinking ? { thinking: options.thinking } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        userInputs: options.userInputs,
        newConversation: !options.conversationId,
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Broker returned HTTP ${response.status}: ${await response.text()}`);
    }
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          const payload = JSON.parse(line);
          if (options.raw) console.log(JSON.stringify(payload));
          else printEvent(payload, state);
        }
        newline = buffered.indexOf('\n');
      }
    }
    if (state.failed) process.exitCode = 2;
  } finally {
    for (const [signal, handler] of terminationHandlers) {
      process.off(signal, handler);
    }
  }
}

main().catch((error) => {
  console.error(`[agent-debug] ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exitCode = 1;
});
