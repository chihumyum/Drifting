#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4317;
const MAX_BODY_BYTES = 1_048_576;
const WATCH_HEARTBEAT_MS = 1_000;
const TERMINAL_EVENT_TYPES = new Set(['bridge_completed', 'bridge_failed']);
const ALLOWED_RENDERER_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'tauri://localhost',
]);

function parseArgs(argv) {
  const options = { host: DEFAULT_HOST, port: DEFAULT_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') {
      options.host = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--port') {
      options.port = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.host) throw new Error('--host requires a value');
  if (!['localhost', '127.0.0.1', '::1'].includes(options.host)) {
    throw new Error('--host must stay on the loopback interface');
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('--port must be an integer from 1 to 65535');
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/agent-headless-debug-server.mjs [--host 127.0.0.1] [--port 4317]',
    '',
    'The renderer bridge only permits loopback URLs. Port 4317 is included in Tauri devCsp.',
  ].join('\n');
}

function setCors(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!ALLOWED_RENDERER_ORIGINS.has(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  return true;
}

function sendJson(response, status, body) {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  response.end(json);
}

function sendEmpty(response, status = 204) {
  response.writeHead(status, { 'Cache-Control': 'no-store' });
  response.end();
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateTurnRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Turn request must be a JSON object');
  }
  if (typeof value.projectId !== 'string' || value.projectId.trim() === '') {
    throw new Error('projectId is required');
  }
  if (typeof value.prompt !== 'string' || value.prompt.trim() === '') {
    throw new Error('prompt is required');
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1_000 ||
      value.timeoutMs > 3_600_000)
  ) {
    throw new Error('timeoutMs must be an integer from 1000 to 3600000');
  }
  if (
    value.permissionMode !== undefined &&
    !['manual', 'allow_once', 'deny'].includes(value.permissionMode)
  ) {
    throw new Error('permissionMode must be manual, allow_once, or deny');
  }
  if (
    value.userInputs !== undefined &&
    (!Array.isArray(value.userInputs) || value.userInputs.some((item) => typeof item !== 'string'))
  ) {
    throw new Error('userInputs must be an array of strings');
  }
  if (value.editMode !== undefined && value.editMode !== 'auto' && value.editMode !== 'approve') {
    throw new Error('editMode must be auto or approve');
  }
  if (value.autoContinue !== undefined && typeof value.autoContinue !== 'boolean') {
    throw new Error('autoContinue must be a boolean');
  }
  return {
    kind: 'turn',
    projectId: value.projectId.trim(),
    prompt: value.prompt.trim(),
    newConversation: value.newConversation !== false,
    ...(typeof value.conversationId === 'string' && value.conversationId.trim()
      ? { conversationId: value.conversationId.trim() }
      : {}),
    timeoutMs: value.timeoutMs ?? 600_000,
    permissionMode: value.permissionMode ?? 'manual',
    autoContinue: value.autoContinue === true,
    userInputs: value.userInputs ?? [],
    ...(value.editMode === 'auto' || value.editMode === 'approve'
      ? { editMode: value.editMode }
      : {}),
  };
}

function validateReviewRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Review request must be a JSON object');
  }
  if (typeof value.projectId !== 'string' || value.projectId.trim() === '') {
    throw new Error('projectId is required');
  }
  if (typeof value.reviewId !== 'string' || value.reviewId.trim() === '') {
    throw new Error('reviewId is required');
  }
  if (value.decision !== 'accept' && value.decision !== 'reject') {
    throw new Error('decision must be accept or reject');
  }
  if (value.note !== undefined && typeof value.note !== 'string') {
    throw new Error('note must be a string');
  }
  return {
    kind: 'review',
    projectId: value.projectId.trim(),
    reviewId: value.reviewId.trim(),
    decision: value.decision,
    ...(value.note?.trim() ? { note: value.note.trim() } : {}),
    timeoutMs: 120_000,
  };
}

function writeNdjson(response, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`${JSON.stringify(payload)}\n`);
}

function summarizeJournalEvent(payload) {
  if (payload?.type === 'bridge_stage') {
    return `[bridge] ${payload.stage ?? 'unknown'}`;
  }
  if (payload?.type !== 'journal') return null;
  const event = payload.entry?.event;
  if (!event || typeof event.type !== 'string') return null;
  switch (event.type) {
    case 'tool_call_ready':
      return `[tool ->] ${event.name} ${JSON.stringify(event.arguments)}`;
    case 'tool_result':
      return `[tool <-] ${event.name} ${event.ok ? 'ok' : 'error'} ${String(event.content).slice(0, 240)}`;
    case 'context_planned': {
      const snapshot = event.snapshot;
      return (
        `[context] ${snapshot.estimatedInputTokens}/${snapshot.contextWindowTokens} ` +
        `free=${snapshot.freeTokens} compaction=${snapshot.compaction.stages.join(',') || 'none'}`
      );
    }
    case 'model_usage':
      return `[usage] iteration=${event.iteration} input=${event.usage.inputTokens} output=${event.usage.outputTokens}`;
    case 'turn_finished':
      return `[turn] ${event.outcome} iterations=${event.modelIterations} duration=${event.durationMs}ms`;
    default:
      return null;
  }
}

function startBroker({ host, port }) {
  const queued = [];
  const jobs = new Map();
  const workers = new Set();
  const startedAt = Date.now();

  const assign = (job, worker) => {
    job.state = 'active';
    job.workerConnectedAt = Date.now();
    worker.busy = true;
    worker.activeRequestId = job.id;
    writeNdjson(worker.response, {
      type: 'request',
      request: {
        requestId: job.id,
        ...job.request,
      },
    });
    console.log(`[agent-debug] claimed ${job.id} project=${job.request.projectId}`);
  };

  const dispatchQueued = () => {
    for (let index = 0; index < queued.length; ) {
      const job = queued[index];
      const worker = [...workers].find(
        (candidate) => !candidate.busy && candidate.projectId === job.request.projectId,
      );
      if (!worker) {
        index += 1;
        continue;
      }
      queued.splice(index, 1);
      assign(job, worker);
    }
  };

  const enqueue = (input, response) => {
    const id = `debug-${randomUUID()}`;
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders?.();
    const job = {
      id,
      request: input,
      response,
      state: 'queued',
      createdAt: Date.now(),
      clientConnected: true,
    };
    jobs.set(id, job);
    response.on('close', () => {
      job.clientConnected = false;
    });
    writeNdjson(response, {
      type: 'queued',
      requestId: id,
      projectId: input.projectId,
      kind: input.kind,
    });
    console.log(`[agent-debug] queued ${id} kind=${input.kind} project=${input.projectId}`);
    queued.push(job);
    dispatchQueued();
  };

  const server = createServer(async (request, response) => {
    if (!setCors(request, response)) {
      sendJson(response, 403, { error: 'Origin is not allowed' });
      return;
    }
    if (request.method === 'OPTIONS') {
      sendEmpty(response);
      return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          queued: queued.filter((job) => job.state === 'queued').length,
          active: [...jobs.values()].filter((job) => job.state === 'active').length,
          rendererPolls: workers.size,
          uptimeMs: Date.now() - startedAt,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/turn') {
        const input = validateTurnRequest(await readJson(request));
        enqueue(input, response);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/review') {
        const input = validateReviewRequest(await readJson(request));
        enqueue(input, response);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/stream') {
        const projectId = url.searchParams.get('projectId')?.trim();
        if (!projectId) {
          sendJson(response, 400, { error: 'projectId query parameter is required' });
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders?.();
        const worker = {
          projectId,
          response,
          busy: false,
          activeRequestId: null,
        };
        workers.add(worker);
        writeNdjson(response, { type: 'heartbeat', now: Date.now() });
        console.log(`[agent-debug] renderer connected project=${projectId}`);
        response.on('close', () => {
          workers.delete(worker);
          console.log(`[agent-debug] renderer disconnected project=${projectId}`);
        });
        dispatchQueued();
        return;
      }

      if (request.method === 'GET' && url.pathname === '/watch') {
        const requestId = url.searchParams.get('requestId')?.trim();
        const projectId = url.searchParams.get('projectId')?.trim();
        const job = requestId ? jobs.get(requestId) : null;
        if (!requestId || !projectId || !job || job.request.projectId !== projectId) {
          sendJson(response, 404, { error: 'Unknown debug request lease' });
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders?.();
        const writeLease = () => {
          const current = jobs.get(requestId);
          if (!current) {
            writeNdjson(response, { exists: false });
            response.end();
            return false;
          }
          const now = Date.now();
          const deadlineAt = current.createdAt + current.request.timeoutMs;
          writeNdjson(response, {
            exists: true,
            now,
            deadlineAt,
            clientConnected: current.clientConnected,
            cancelRequested: !current.clientConnected || now >= deadlineAt,
            reason: !current.clientConnected
              ? 'client_disconnected'
              : now >= deadlineAt
                ? 'deadline_exceeded'
                : null,
          });
          return true;
        };
        if (!writeLease()) return;
        const heartbeat = setInterval(() => {
          if (!writeLease()) clearInterval(heartbeat);
        }, WATCH_HEARTBEAT_MS);
        heartbeat.unref();
        response.on('close', () => clearInterval(heartbeat));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/events') {
        const body = await readJson(request);
        const requestId = typeof body.requestId === 'string' ? body.requestId : '';
        const events = Array.isArray(body.events) ? body.events : [];
        const job = jobs.get(requestId);
        if (!job) {
          sendJson(response, 404, { error: 'Unknown or completed requestId' });
          return;
        }
        let terminal = false;
        for (const payload of events) {
          writeNdjson(job.response, payload);
          const summary = summarizeJournalEvent(payload);
          if (summary) console.log(`[agent-debug] ${requestId} ${summary}`);
          if (TERMINAL_EVENT_TYPES.has(payload?.type)) {
            terminal = true;
            job.state = payload.type === 'bridge_completed' ? 'completed' : 'failed';
            console.log(`[agent-debug] ${requestId} ${job.state}`);
          }
        }
        sendJson(response, 202, { accepted: events.length });
        if (terminal) {
          const worker = [...workers].find((candidate) => candidate.activeRequestId === requestId);
          if (worker) {
            worker.busy = false;
            worker.activeRequestId = null;
          }
          if (!job.response.writableEnded) job.response.end();
          jobs.delete(requestId);
          const queuedIndex = queued.findIndex((candidate) => candidate.id === requestId);
          if (queuedIndex >= 0) queued.splice(queuedIndex, 1);
          dispatchQueued();
        }
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) sendJson(response, 400, { error: message });
      else response.end(`${JSON.stringify({ type: 'broker_error', error: message })}\n`);
    }
  });

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      const deadline = job.createdAt + job.request.timeoutMs + 120_000;
      if (now <= deadline) continue;
      writeNdjson(job.response, {
        type: 'bridge_failed',
        requestId: job.id,
        error: 'Debug broker expired an abandoned request',
      });
      if (!job.response.writableEnded) job.response.end();
      jobs.delete(job.id);
      const worker = [...workers].find((candidate) => candidate.activeRequestId === job.id);
      if (worker) {
        worker.busy = false;
        worker.activeRequestId = null;
      }
      const index = queued.findIndex((candidate) => candidate.id === job.id);
      if (index >= 0) queued.splice(index, 1);
    }
    dispatchQueued();
  }, 30_000);
  cleanup.unref();

  const workerHeartbeat = setInterval(() => {
    for (const worker of workers) {
      writeNdjson(worker.response, { type: 'heartbeat', now: Date.now() });
    }
  }, WATCH_HEARTBEAT_MS);
  workerHeartbeat.unref();

  server.on('close', () => {
    clearInterval(cleanup);
    clearInterval(workerHeartbeat);
    for (const worker of workers) worker.response.end();
    for (const job of jobs.values()) {
      if (!job.response.writableEnded) job.response.end();
    }
  });

  server.listen(port, host, () => {
    console.log(`[agent-debug] broker listening on http://${host}:${port}`);
    console.log('[agent-debug] waiting for a DEV renderer with VITE_DRIFTING_AGENT_DEBUG_URL set');
  });
  return server;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    startBroker(options);
  }
} catch (error) {
  console.error(`[agent-debug] ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exitCode = 1;
}
