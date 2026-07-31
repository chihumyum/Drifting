#!/usr/bin/env node

const DEFAULT_URL = 'http://127.0.0.1:4317';
const DEFAULT_TIMEOUT_MS = 240_000;
const PROJECT_TEST_NODE = 'agent wrote this';
const MARKER = '[AGENT-HEADLESS-EVAL]';

const CERTIFIED_WRITES = new Set([
  'rename_node',
  'set_node_summary',
  'edit_block',
  'edit_blocks',
  'append_paragraph',
  'insert_blocks',
  'remove_blocks',
  'replace_block_range',
  'create_element_patch',
  'update_element_patch',
  'update_element',
  'update_storyline',
  'update_project_facts',
  'create_comment',
]);

const COMMON = [
  '这是真实 renderer 写入验收。',
  '只允许调用下面指定的读取工具和指定写工具；指定写工具必须恰好成功一次。',
  '写入会进入待审批状态并由测试器立即 reject 回滚。',
  '不要调用任何其他写工具，不要伪造 freshness，必须逐字段复制读取结果中的 freshness 引用。',
].join('');

const SCENARIOS = [
  {
    id: 'rename-node',
    write: 'rename_node',
    read: 'read_node',
    prompt: `${COMMON} 先调用 read_node(node="${PROJECT_TEST_NODE}", prose=false)，复制 entityKind=node 的 observation 为 expectedRevision；然后调用 rename_node，把标题改为 "${PROJECT_TEST_NODE} ${MARKER}"。`,
  },
  {
    id: 'set-node-summary',
    write: 'set_node_summary',
    read: 'read_node',
    prompt: `${COMMON} 先调用 read_node(node="${PROJECT_TEST_NODE}", prose=false)，复制 entityKind=node 的 observation 为 expectedRevision；然后调用 set_node_summary，把 summary 设为 "${MARKER} temporary summary"。`,
  },
  {
    id: 'edit-block',
    write: 'edit_block',
    read: 'read_node',
    prompt: `${COMMON} 先调用 read_node(node="${PROJECT_TEST_NODE}", prose=true)，复制 entityKind=node_prose 的 observation 为 expectedRevision；然后调用 edit_block(entity="${PROJECT_TEST_NODE}", block=1)，保留第1段原文并在末尾追加 " ${MARKER}"。`,
  },
  {
    id: 'edit-blocks',
    write: 'edit_blocks',
    read: 'read_node',
    prompt: `${COMMON} 先调用 read_node(node="${PROJECT_TEST_NODE}", prose=true)，复制 entityKind=node_prose 的 observation 为 expectedRevision；然后调用 edit_blocks(entity="${PROJECT_TEST_NODE}")，原子修改第1、2段，分别保留原文并在末尾追加 " ${MARKER} one" 与 " ${MARKER} two"。`,
  },
  {
    id: 'append-paragraph',
    write: 'append_paragraph',
    read: 'read_node',
    prompt: `${COMMON} 先调用 read_node(node="${PROJECT_TEST_NODE}", prose=true)，复制 entityKind=node_prose 的 observation 为 expectedRevision；然后调用 append_paragraph(entity="${PROJECT_TEST_NODE}", text="${MARKER} appended paragraph")。`,
  },
  {
    id: 'insert-blocks',
    write: 'insert_blocks',
    read: 'read_node',
    prompt: `${COMMON} 先调用 read_node(node="${PROJECT_TEST_NODE}", prose=true)，复制 entityKind=node_prose 的 observation 为 expectedRevision；然后调用 insert_blocks(entity="${PROJECT_TEST_NODE}", afterBlock=1, blocks=["${MARKER} inserted one","${MARKER} inserted two"])。`,
  },
  {
    id: 'remove-blocks',
    write: 'remove_blocks',
    read: 'read_node',
    prompt: `${COMMON} 先调用 read_node(node="${PROJECT_TEST_NODE}", prose=true)，确认至少有3段并复制 entityKind=node_prose 的 observation 为 expectedRevision；然后调用 remove_blocks(entity="${PROJECT_TEST_NODE}", blockNumbers=[3])。`,
  },
  {
    id: 'replace-block-range',
    write: 'replace_block_range',
    read: 'read_node',
    prompt: `${COMMON} 先调用 read_node(node="${PROJECT_TEST_NODE}", prose=true)，确认至少有3段并复制 entityKind=node_prose 的 observation 为 expectedRevision；然后调用 replace_block_range(entity="${PROJECT_TEST_NODE}", fromBlock=2, toBlock=3, blocks=["${MARKER} range one","${MARKER} range two"])。`,
  },
  {
    id: 'create-element-patch',
    write: 'create_element_patch',
    read: 'get_element_patches',
    prompt: `${COMMON} 先调用 get_element_patches(element="Grey Banker")，复制 entityKind=element_patch_set 的 observation 为 expectedRevision；然后调用 create_element_patch(element="Grey Banker", title="${MARKER} temporary patch", body="temporary", sourceChapter="01")。`,
  },
  {
    id: 'update-element-patch',
    write: 'update_element_patch',
    read: 'get_element_patches',
    prompt: `${COMMON} 先调用 get_element_patches(element="Grey Banker")，选择返回的第一条 patch，并复制该 patch 对应 entityKind=element_patch 的 observation 为 expectedRevision；然后调用 update_element_patch，保留原 title 并在末尾追加 " ${MARKER}"。patchId 必须来自读取结果。`,
  },
  {
    id: 'update-element',
    write: 'update_element',
    read: 'read_element',
    prompt: `${COMMON} 先调用 read_element(element="Grey Banker")，复制 entityKind=element 的 observation 为 expectedRevision；然后调用 update_element，只修改 summary，保留原 summary 并在末尾追加 " ${MARKER}"。`,
  },
  {
    id: 'update-storyline',
    write: 'update_storyline',
    read: 'get_storyline',
    prompt: `${COMMON} 先调用 get_storyline(storyline="Mortals")，复制 entityKind=storyline 的 observation 为 expectedRevision；然后调用 update_storyline，只修改 summary，保留原 summary 并在末尾追加 " ${MARKER}"。`,
  },
  {
    id: 'update-project-facts',
    write: 'update_project_facts',
    read: 'get_project_brief',
    prompt: `${COMMON} 先调用 get_project_brief，复制 entityKind=project 的 observation 为 expectedRevision；然后调用 update_project_facts(facts=[{key:"__agent_headless_eval__",value:"${MARKER}"}])。`,
  },
  {
    id: 'create-comment',
    write: 'create_comment',
    read: 'get_project_brief',
    prompt: `${COMMON} 先调用 get_project_brief，复制 entityKind=project 的 observation 为 expectedRevision；然后调用 create_comment(body="${MARKER} temporary comment", kind="note", targetKind="node", target="${PROJECT_TEST_NODE}")。`,
  },
];

function parseArgs(argv) {
  const options = {
    url: process.env.DRIFTING_AGENT_DEBUG_URL || DEFAULT_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    only: [],
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
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  pnpm agent:debug:writes -- --project <id> [--only <scenario>]',
    '',
    'Every successful write is created in approve mode and immediately rejected.',
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
  let primaryError = null;
  try {
    const bridgeFailure = payloads.find((payload) => payload.type === 'bridge_failed');
    if (bridgeFailure) throw new Error(bridgeFailure.error);
    const completed = payloads.find((payload) => payload.type === 'bridge_completed');
    if (!completed || completed.outcome !== 'completed') {
      throw new Error(`turn outcome=${completed?.outcome ?? 'missing'}`);
    }
    const expectedCalls = calls.filter((call) => call.name === scenario.write);
    if (expectedCalls.length < 1 || expectedCalls.length > 2) {
      throw new Error(
        `${scenario.write} call count=${expectedCalls.length}, expected 1 or one schema-correction retry`,
      );
    }
    if (!calls.some((call) => call.name === scenario.read)) {
      throw new Error(`missing prerequisite read ${scenario.read}`);
    }
    const unexpectedWrites = calls
      .filter((call) => CERTIFIED_WRITES.has(call.name) && call.name !== scenario.write)
      .map((call) => call.name);
    if (unexpectedWrites.length) {
      throw new Error(`unexpected writes: ${unexpectedWrites.join(', ')}`);
    }
    const writeResults = results.filter((event) => event.name === scenario.write);
    const successfulWriteResults = writeResults.filter((event) => event.ok);
    if (successfulWriteResults.length !== 1) {
      throw new Error(
        `${scenario.write} successful result count=${successfulWriteResults.length}, expected 1; ` +
          `results=${writeResults.map((result) => `${result.ok ? 'ok' : 'error'}:${result.content}`).join(' | ') || 'missing'}`,
      );
    }
    const pendingReviews = reviews.filter(
      (review) => review.toolName === scenario.write && review.status === 'pending',
    );
    const successfulCallId = successfulWriteResults[0].callId;
    if (pendingReviews.length !== 1 || pendingReviews[0].callId !== successfulCallId) {
      throw new Error(`${scenario.write} did not create one pending review`);
    }
  } catch (error) {
    primaryError = error;
  }

  let rollbackError = null;
  for (const review of [...reviews].reverse()) {
    try {
      await rejectReview(options, review);
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
  console.log(`[PASS] ${scenario.id} -> ${scenario.write} -> reverted`);
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
