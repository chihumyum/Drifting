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
    console.error(`[failed] ${payload.error}`);
    state.failed = true;
    return;
  }
  if (payload.type !== 'journal') return;
  const event = payload.entry?.event;
  if (!event) return;
  switch (event.type) {
    case 'tool_call_ready':
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
  const state = {
    failed: false,
    permissionMode: options.permissionMode,
    autoContinue: options.autoContinue === true,
  };
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
}

main().catch((error) => {
  console.error(`[agent-debug] ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exitCode = 1;
});
