/**
 * Data-driven eval schemas (zod). Goldens, cases, and suites are DATA on disk —
 * this is the single source of truth that validates them. The same operator param
 * schemas (operators.ts) also drive AI case-generation and (later) the in-app case
 * editor, so a case the runner accepts is a case the generator can produce.
 *
 * Cases reference a golden by logical id (loose binding — fixing a typo doesn't
 * invalidate 200 cases) and an operator by id + params; provenance/contentHash give
 * the tight, run-artifact-recorded traceability.
 */
import { z } from 'zod';

const zKV = z.record(z.string(), z.string());

// ── golden fixture ────────────────────────────────────────────────────────────
const zElement = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  facts: zKV,
  body: z.string().optional(),
});

const zBlock = z.object({ id: z.string(), text: z.string() });

// Prose read at runtime from a vault file (copyright-private manuscripts never get
// frozen into the fixture — only elements/facts/rules + this pointer do).
const zBodySource = z.object({
  kind: z.literal('vault-md'),
  file: z.string(),
  dir: z.string().optional(), // default = $FOG_HARBOR_DIR
});

const zChapter = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  appears: z.array(z.string()).optional(),
  blocks: z.array(zBlock).optional(), // inline prose …
  bodySource: zBodySource.optional(), // … OR runtime-read prose
});

const zRule = z.object({
  id: z.string(),
  checklist: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      assertion: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export const zGolden = z.object({
  $schema: z.string().optional(),
  id: z.string(),
  contentHash: z.string().optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
  project: z.object({
    projectId: z.string(),
    facts: zKV,
    elements: z.array(zElement),
    rules: z.array(zRule),
    chapters: z.array(zChapter),
  }),
});
export type GoldenFile = z.infer<typeof zGolden>;

// ── case (one row of a dataset) ─────────────────────────────────────────────────
export const zExpectFlag = z.object({
  chapterId: z.string(),
  ruleId: z.string(),
  shouldFlag: z.boolean(),
});

const zOpRef = z.object({
  op: z.string(),
  params: z.record(z.string(), z.unknown()),
});

export const zCase = z.object({
  id: z.string(),
  golden: z.string(),
  // single operator …
  op: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  // … OR an ordered composite (replaces the old hand-written closures)
  ops: z.array(zOpRef).optional(),
  expect: z.array(zExpectFlag),
  scope: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  provenance: z.record(z.string(), z.unknown()).optional(),
});
export type EvalCase = z.infer<typeof zCase>;

// ── suite (what to run + how + the gate) ─────────────────────────────────────────
const zGate = z
  .object({
    maxFP: z.number().optional(),
    maxFN: z.number().optional(),
    minPrecision: z.number().optional(),
    minRecall: z.number().optional(),
  })
  .optional();

export const zSuite = z.object({
  id: z.string(),
  datasets: z.array(z.string()),
  client: z.enum(['mock', 'deepseek']).default('mock'),
  repeat: z.number().default(1),
  concurrency: z.number().optional(),
  timeoutMs: z.number().optional(),
  gate: zGate,
});
export type Suite = z.infer<typeof zSuite>;
