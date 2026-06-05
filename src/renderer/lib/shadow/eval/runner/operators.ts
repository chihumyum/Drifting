/**
 * Operator registry — the small, FIXED code vocabulary that data cases reference by
 * id. Each operator pairs a zod param schema (validates the case, and is the same
 * schema an AI generator / in-app form would use) with a `build` that calls the
 * existing mutation factory in ../mutations. Cases are data; operators are code.
 *
 * `caseToMutation` turns one data case into the in-memory Mutation the runner feeds
 * to runEval, with a DRIFT GUARD: a single-operator case must declare the same
 * `expect` the operator computes by construction — so editing an operator's
 * semantics without updating the data fails loudly instead of silently rescoring.
 */
import { z } from 'zod';
import {
  cleanBaseline,
  injectBannedWord,
  injectBlock,
  contradictInProse,
  changeDependency,
  changeDependencyIrrelevant,
  type ExpectFlag,
  type Mutation,
} from '../mutations';

interface OperatorDef {
  paramsSchema: z.ZodType;
  build: (caseId: string, params: unknown) => Mutation;
}

const pairList = z.array(z.object({ chapterId: z.string(), ruleId: z.string() }));

export const OPERATORS: Record<string, OperatorDef> = {
  cleanBaseline: {
    paramsSchema: z.object({ pairs: pairList }),
    build: (_id, p) => cleanBaseline((p as { pairs: ExpectFlag[] }).pairs),
  },
  injectBannedWord: {
    paramsSchema: z.object({
      chapterId: z.string(),
      blockId: z.string(),
      word: z.string(),
      ruleId: z.string(),
    }),
    build: (id, p) => {
      const x = p as { chapterId: string; blockId: string; word: string; ruleId: string };
      return injectBannedWord(id, x.chapterId, x.blockId, x.word, x.ruleId);
    },
  },
  injectBlock: {
    paramsSchema: z.object({
      chapterId: z.string(),
      text: z.string(),
      ruleId: z.string(),
      label: z.string().optional(),
    }),
    build: (id, p) => {
      const x = p as { chapterId: string; text: string; ruleId: string; label?: string };
      return injectBlock(id, x.chapterId, x.text, x.ruleId, x.label);
    },
  },
  contradictInProse: {
    paramsSchema: z.object({
      chapterId: z.string(),
      blockId: z.string(),
      find: z.string(),
      replace: z.string(),
      ruleId: z.string(),
    }),
    build: (id, p) => {
      const x = p as { chapterId: string; blockId: string; find: string; replace: string; ruleId: string };
      return contradictInProse(id, x.chapterId, x.blockId, x.find, x.replace, x.ruleId);
    },
  },
  changeDependency: {
    paramsSchema: z.object({
      elementName: z.string(),
      factKey: z.string(),
      newValue: z.string(),
      affected: pairList,
    }),
    build: (id, p) => {
      const x = p as { elementName: string; factKey: string; newValue: string; affected: ExpectFlag[] };
      return changeDependency(id, x.elementName, x.factKey, x.newValue, x.affected);
    },
  },
  changeDependencyIrrelevant: {
    paramsSchema: z.object({
      elementName: z.string(),
      factKey: z.string(),
      newValue: z.string(),
      control: pairList,
    }),
    build: (id, p) => {
      const x = p as { elementName: string; factKey: string; newValue: string; control: ExpectFlag[] };
      return changeDependencyIrrelevant(id, x.elementName, x.factKey, x.newValue, x.control);
    },
  },
};

export const OPERATOR_IDS = Object.keys(OPERATORS);

function buildOp(caseId: string, op: string, rawParams: unknown): Mutation {
  const def = OPERATORS[op];
  if (!def) throw new Error(`case ${caseId}: 未知 operator "${op}"（可用：${OPERATOR_IDS.join(', ')}）`);
  let params: unknown;
  try {
    params = def.paramsSchema.parse(rawParams ?? {});
  } catch (e) {
    throw new Error(`case ${caseId}: operator "${op}" 参数非法 — ${(e as Error).message}`);
  }
  return def.build(caseId, params);
}

const keyOf = (e: ExpectFlag) => `${e.chapterId}|${e.ruleId}|${e.shouldFlag}`;

function assertSameExpect(caseId: string, fromOp: ExpectFlag[], declared: ExpectFlag[]): void {
  const a = new Set(fromOp.map(keyOf));
  const b = new Set(declared.map(keyOf));
  const missing = [...b].filter((x) => !a.has(x));
  const extra = [...a].filter((x) => !b.has(x));
  if (missing.length || extra.length) {
    throw new Error(
      `case ${caseId}: 声明的 expect 与 operator 自算不一致` +
        (missing.length ? ` · 缺[${missing.join(' ')}]` : '') +
        (extra.length ? ` · 多[${extra.join(' ')}]` : ''),
    );
  }
}

// One data case → the in-memory Mutation runEval consumes.
export function caseToMutation(c: {
  id: string;
  op?: string;
  params?: unknown;
  ops?: { op: string; params: unknown }[];
  expect: ExpectFlag[];
  scope?: string[];
}): Mutation {
  const expect = c.expect;
  const scope = c.scope ?? [...new Set(expect.map((e) => e.chapterId))];

  if (c.ops && c.ops.length) {
    // Composite: run each sub-operator's edit in order; the combined fault's label
    // can't be derived from any single operator, so we trust the declared expect
    // (no per-op cross-check — that's the price of composites).
    const subs = c.ops.map((step, i) => buildOp(`${c.id}:${i}`, step.op, step.params));
    return { id: c.id, label: c.id, apply: (p) => subs.forEach((s) => s.apply(p)), expect, scope };
  }

  if (!c.op) throw new Error(`case ${c.id}: 需要 op 或 ops`);
  const m = buildOp(c.id, c.op, c.params);
  assertSameExpect(c.id, m.expect, expect); // drift guard
  return { ...m, expect, scope };
}
