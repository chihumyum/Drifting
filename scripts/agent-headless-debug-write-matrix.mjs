#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const DEFAULT_URL = 'http://127.0.0.1:4317';
const DEFAULT_TIMEOUT_MS = 240_000;
const PROJECT_TEST_NODE = 'agent wrote this';
const MARKER = `[AGENT-HEADLESS-EVAL:${Date.now().toString(36)}]`;

const CAPABILITY_MANIFEST = JSON.parse(
  readFileSync(
    new URL('../docs/agent-runtime/acceptance/agent-capabilities.json', import.meta.url),
    'utf8',
  ),
);
const PROVIDER_WRITES = new Set(
  CAPABILITY_MANIFEST.installedModelTools.entries
    .filter((tool) => tool.surface === 'domain-tools' && tool.access === 'write')
    .map((tool) => tool.name),
);

const COMMON = [
  '这是隔离数据库副本上的真实 renderer 写入验收。',
  '先读取目标的当前内容，再执行恰好一次指定改动。',
  '只改明确指定的内容，不要创建替代实体，不要解释内部存储或协调机制。',
].join('');

const SCENARIOS = [
  {
    id: 'set-node-summary',
    write: 'set_chapter_summary',
    read: 'read_chapter',
    prompt: `${COMMON} 请读取章节「${PROJECT_TEST_NODE}」的摘要，然后把摘要完整替换为「${MARKER} temporary summary」。`,
  },
  {
    id: 'edit-block',
    write: 'revise_chapter',
    read: 'read_chapter',
    prompt: `${COMMON} 请读取章节「${PROJECT_TEST_NODE}」正文，仅在第1段末尾追加「 ${MARKER}」，其余原文不变。`,
  },
  {
    id: 'edit-blocks',
    write: 'revise_chapter',
    read: 'read_chapter',
    prompt: `${COMMON} 请读取章节「${PROJECT_TEST_NODE}」正文，在同一次改动中分别于第1段和第2段末尾追加「 ${MARKER} one」与「 ${MARKER} two」，其余原文不变。`,
  },
  {
    id: 'append-paragraph',
    write: 'revise_chapter',
    read: 'read_chapter',
    prompt: `${COMMON} 请读取章节「${PROJECT_TEST_NODE}」正文，在末尾追加一个新段落，内容恰好为「${MARKER} appended paragraph」。`,
  },
  {
    id: 'insert-blocks',
    write: 'revise_chapter',
    read: 'read_chapter',
    prompt: `${COMMON} 请读取章节「${PROJECT_TEST_NODE}」正文，在第1段后依次插入两个新段落「${MARKER} inserted one」和「${MARKER} inserted two」，其余原文不变。`,
  },
  {
    id: 'remove-blocks',
    write: 'revise_chapter',
    read: 'read_chapter',
    prompt: `${COMMON} 请读取章节「${PROJECT_TEST_NODE}」正文，删除第3段，保留其他段落及其顺序。`,
  },
  {
    id: 'replace-block-range',
    write: 'revise_chapter',
    read: 'read_chapter',
    prompt: `${COMMON} 请读取章节「${PROJECT_TEST_NODE}」正文，把第2至第3段整体替换为两个段落「${MARKER} range one」和「${MARKER} range two」，第1段不变。`,
  },
  {
    id: 'create-element-patch',
    write: 'create_element_patch',
    read: 'get_element_patches',
    prompt: `${COMMON} 请读取人物「Grey Banker」现有的元素补丁，然后为它新增一个标题为「${MARKER} temporary patch」、正文为「temporary」、来源章节为「01」的元素补丁。`,
  },
  {
    id: 'update-element-patch',
    write: 'update_element_patch',
    read: 'get_element_patches',
    prompt: `${COMMON} 请读取人物「Grey Banker」现有的元素补丁，选择第一条，把它的标题在保留原文的基础上追加「 ${MARKER}」。`,
  },
  {
    id: 'update-element',
    write: 'update_element',
    read: 'read_element',
    prompt: `${COMMON} 请读取人物「Grey Banker」的摘要，只在现有摘要末尾追加「 ${MARKER}」，其他内容不变。`,
  },
  {
    id: 'update-storyline',
    write: 'update_storyline',
    read: 'read_storyline',
    prompt: `${COMMON} 请读取故事线「Mortals」的摘要，只在现有摘要末尾追加「 ${MARKER}」，其他内容不变。`,
  },
  {
    id: 'update-project-facts',
    write: 'update_project_facts',
    read: 'get_project_facts',
    prompt: `${COMMON} 请读取项目事实，新增一条名称为「__agent_headless_eval__」、内容为「${MARKER}」的事实，保留所有已有事实。`,
  },
  {
    id: 'create-comment',
    write: 'create_comment',
    read: 'list_comments',
    prompt: `${COMMON} 请先浏览批注，然后创建一条指向章节「${PROJECT_TEST_NODE}」的普通批注，正文为「${MARKER} temporary comment」。`,
  },
  // Keep rename last because metadata writes are automatic rather than inline
  // editor reviews. The changed authored name must not invalidate later scenarios in
  // the disposable database.
  {
    id: 'rename-node',
    write: 'rename_chapter',
    read: 'read_chapter',
    prompt: `${COMMON} 请读取章节「${PROJECT_TEST_NODE}」的标题，然后把标题改为「${PROJECT_TEST_NODE} ${MARKER}」。`,
  },
];

function parseArgs(argv) {
  const options = {
    url: process.env.DRIFTING_AGENT_DEBUG_URL || DEFAULT_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    only: [],
    disposableDb: false,
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
    else if (arg === '--url') options.url = next();
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--only') options.only.push(next());
    else if (arg === '--disposable-db') options.disposableDb = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  pnpm agent:debug:writes -- --project <id> --disposable-db [--only <scenario>]',
    '',
    'Required safety flag: --disposable-db. Never point this command at the primary App database.',
    'Inline prose reviews are immediately rejected. Automatic and confirm-before',
    'structured writes remain only in the disposable database and are removed with it.',
    'Use --list to print scenario ids.',
  ].join('\n');
}

async function requestNdjson(url, path, body) {
  const response = await fetch(new URL(path, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    throw new Error(`${path} returned HTTP ${response.status}: ${await response.text()}`);
  }
  const decoder = new TextDecoder();
  const payloads = [];
  let buffered = '';
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) payloads.push(JSON.parse(line));
      newline = buffered.indexOf('\n');
    }
  }
  if (buffered.trim()) payloads.push(JSON.parse(buffered.trim()));
  return payloads;
}

function journalEvents(payloads) {
  return payloads
    .filter((payload) => payload.type === 'journal' && payload.entry?.event)
    .map((payload) => payload.entry.event);
}

function parseReviewFromToolResult(event) {
  if (event.type !== 'tool_result' || !event.ok || typeof event.content !== 'string') return null;
  if (typeof event.review?.id === 'string') {
    return {
      id: event.review.id,
      status: event.review.status,
      toolName: event.name,
      callId: event.callId,
    };
  }
  // Backward compatibility for journals written before review presentation
  // metadata was separated from provider-visible tool content.
  try {
    const content = JSON.parse(event.content);
    if (typeof content.review?.id !== 'string') return null;
    return {
      id: content.review.id,
      status: content.review.status,
      toolName: event.name,
      callId: event.callId,
    };
  } catch {
    return null;
  }
}

async function rejectReview(options, review) {
  const payloads = await requestNdjson(options.url, '/review', {
    projectId: options.projectId,
    reviewId: review.id,
    decision: 'reject',
    note: `Automated headless write-matrix rollback for ${review.toolName}`,
  });
  const failed = payloads.find((payload) => payload.type === 'bridge_failed');
  if (failed) throw new Error(`review ${review.id} rollback failed: ${failed.error}`);
  const result = payloads.find((payload) => payload.type === 'review_result')?.result;
  const terminal = payloads.find((payload) => payload.type === 'bridge_completed');
  if (!terminal || result?.review?.status !== 'reverted') {
    throw new Error(
      `review ${review.id} did not revert (status=${result?.review?.status ?? terminal?.status ?? 'missing'})`,
    );
  }
}

async function runScenario(options, scenario) {
  const payloads = await requestNdjson(options.url, '/turn', {
    projectId: options.projectId,
    prompt: scenario.prompt,
    timeoutMs: options.timeoutMs,
    permissionMode: 'manual',
    editMode: 'approve',
    userInputs: [],
    newConversation: true,
  });
  const events = journalEvents(payloads);
  const calls = events.filter((event) => event.type === 'tool_call_ready');
  const results = events.filter((event) => event.type === 'tool_result');
  const reviews = results.map(parseReviewFromToolResult).filter(Boolean);
  const expectedWriteNames = [scenario.write];
  let successfulWriteResult = null;
  let reviewWasReverted = false;
  let primaryError = null;
  try {
    const bridgeFailure = payloads.find((payload) => payload.type === 'bridge_failed');
    if (bridgeFailure) throw new Error(bridgeFailure.error);
    const completed = payloads.find((payload) => payload.type === 'bridge_completed');
    if (!completed || completed.outcome !== 'completed') {
      throw new Error(`turn outcome=${completed?.outcome ?? 'missing'}`);
    }
    const expectedCalls = calls.filter((call) => expectedWriteNames.includes(call.name));
    if (expectedCalls.length < 1 || expectedCalls.length > 2) {
      throw new Error(
        `${expectedWriteNames.join('/')} call count=${expectedCalls.length}, expected 1 or one schema-correction retry`,
      );
    }
    if (!calls.some((call) => call.name === scenario.read)) {
      throw new Error(`missing prerequisite read ${scenario.read}`);
    }
    const unexpectedWrites = calls
      .filter((call) => PROVIDER_WRITES.has(call.name) && !expectedWriteNames.includes(call.name))
      .map((call) => call.name);
    if (unexpectedWrites.length) {
      throw new Error(`unexpected writes: ${unexpectedWrites.join(', ')}`);
    }
    const writeResults = results.filter((event) => expectedWriteNames.includes(event.name));
    const successfulWriteResults = writeResults.filter((event) => event.ok);
    if (successfulWriteResults.length !== 1) {
      throw new Error(
        `${expectedWriteNames.join('/')} successful result count=${successfulWriteResults.length}, expected 1; ` +
          `results=${writeResults.map((result) => `${result.ok ? 'ok' : 'error'}:${result.content}`).join(' | ') || 'missing'}`,
      );
    }
    successfulWriteResult = successfulWriteResults[0];
    const pendingReviews = reviews.filter(
      (review) => expectedWriteNames.includes(review.toolName) && review.status === 'pending',
    );
    const successfulCallId = successfulWriteResults[0].callId;
    if (
      pendingReviews.length > 1 ||
      (pendingReviews.length === 1 && pendingReviews[0].callId !== successfulCallId)
    ) {
      throw new Error(`${scenario.write} created an invalid pending review set`);
    }
  } catch (error) {
    primaryError = error;
  }

  let rollbackError = null;
  for (const review of [...reviews].reverse()) {
    try {
      await rejectReview(options, review);
      reviewWasReverted = true;
    } catch (error) {
      rollbackError ??= error;
    }
  }
  if (rollbackError) {
    throw new Error(
      `${scenario.id}: ${primaryError ? `${primaryError.message}; ` : ''}${rollbackError.message}`,
    );
  }
  if (primaryError) throw new Error(`${scenario.id}: ${primaryError.message}`);
  if (!successfulWriteResult) throw new Error(`${scenario.id}: successful write result missing`);
  console.log(
    reviewWasReverted
      ? `[PASS] ${scenario.id} -> ${successfulWriteResult.name} -> review reverted`
      : `[PASS] ${scenario.id} -> ${successfulWriteResult.name} -> automatic/confirmed in disposable DB`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.list) {
    for (const scenario of SCENARIOS) console.log(scenario.id);
    return;
  }
  if (!options.projectId) throw new Error('--project is required');
  if (!options.disposableDb) {
    throw new Error(
      '--disposable-db is required because structured authored-object writes may not create an inline review',
    );
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer >= 1000');
  }
  const selected = options.only.length
    ? SCENARIOS.filter((scenario) => options.only.includes(scenario.id))
    : SCENARIOS;
  const unknown = options.only.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(', ')}`);

  const health = await fetch(new URL('/health', options.url)).then((response) => response.json());
  if (!health.ok) throw new Error('Agent debug broker is not healthy');
  console.log(`[agent-debug] running ${selected.length} reversible write scenarios`);
  for (const scenario of selected) await runScenario(options, scenario);
  console.log(`[PASS] write matrix ${selected.length}/${selected.length}`);
}

main().catch((error) => {
  console.error(`[agent-debug] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
