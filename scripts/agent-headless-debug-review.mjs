#!/usr/bin/env node

const DEFAULT_URL = 'http://127.0.0.1:4317';

function parseArgs(argv) {
  const options = { url: process.env.DRIFTING_AGENT_DEBUG_URL || DEFAULT_URL };
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
    else if (arg === '--review') options.reviewId = next();
    else if (arg === '--decision') options.decision = next();
    else if (arg === '--note') options.note = next();
    else if (arg === '--url') options.url = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  pnpm agent:debug:review -- --project <id> --review <id> --decision accept|reject',
    '',
    'Options:',
    '  --note <text>',
    '  --url <http://127.0.0.1:4317>',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.projectId || !options.reviewId) {
    throw new Error('--project and --review are required');
  }
  if (options.decision !== 'accept' && options.decision !== 'reject') {
    throw new Error('--decision must be accept or reject');
  }
  const response = await fetch(new URL('/review', options.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: options.projectId,
      reviewId: options.reviewId,
      decision: options.decision,
      ...(options.note ? { note: options.note } : {}),
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
        if (payload.type === 'review_result') {
          console.log(JSON.stringify(payload.result, null, 2));
        } else if (payload.type === 'bridge_failed') {
          throw new Error(payload.error);
        } else if (payload.type === 'bridge_completed') {
          console.log(`[completed] review=${payload.reviewId} status=${payload.status}`);
        }
      }
      newline = buffered.indexOf('\n');
    }
  }
}

main().catch((error) => {
  console.error(`[agent-debug] ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exitCode = 1;
});
