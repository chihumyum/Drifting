/**
 * Mutation operators — deterministic fault injection over a cloned project. Each
 * produces a labeled `Mutation`: an edit + the (chapter, rule) pairs whose verdict
 * it should change. Because the edit is mechanical, the label is TRUE BY
 * CONSTRUCTION — no human annotation.
 *
 * AI-generated mutations (the "让 AI 造漏洞" path) plug in here too: a generator
 * proposes the same {apply, expect} shape, gated by a certification step before
 * it's trusted as ground truth (see README). The deterministic operators below
 * are the seed + the certain-label baseline.
 */
import type { EvalProject } from './model';

export interface ExpectFlag {
  chapterId: string;
  ruleId: string;
  shouldFlag: boolean; // true = this rule SHOULD fire on this chapter; false = must stay clean
}

export interface Mutation {
  id: string;
  label: string;
  apply: (p: EvalProject) => void; // edits the CLONE in place
  expect: ExpectFlag[];
  // Chapters to review for this mutation (default = the chapters named in expect).
  // In a fuller version this comes from the staleness selector (and verifying it
  // matches is how we test the dep graph).
  scope?: string[];
  // Canon nodes this mutation edited (name + field) — the SAME pointer the real
  // dep-graph would surface on a canon edit. Forwarded to the judge as a recheck
  // hint (no values) so we can measure cold-rediscovery vs hinted recall.
  depChanges?: { name: string; fact?: string }[];
}

// ── low-level edit helpers (operate on a clone) ───────────────────────────────
function chapter(p: EvalProject, id: string) {
  const c = p.chapters.find((x) => x.id === id);
  if (!c) throw new Error(`eval mutation: no chapter "${id}"`);
  return c;
}
function block(p: EvalProject, chapterId: string, blockId: string) {
  const b = chapter(p, chapterId).blocks.find((x) => x.id === blockId);
  if (!b) throw new Error(`eval mutation: no block "${blockId}" in "${chapterId}"`);
  return b;
}
function element(p: EvalProject, name: string) {
  const e = p.elements.find((x) => x.name === name);
  if (!e) throw new Error(`eval mutation: no element "${name}"`);
  return e;
}

export function scopeOf(m: Mutation): string[] {
  return m.scope ?? [...new Set(m.expect.map((e) => e.chapterId))];
}

// ── operators ─────────────────────────────────────────────────────────────────

/** No edit. Asserts the whole listed surface stays clean → measures FALSE POSITIVES. */
export function cleanBaseline(allPairs: Omit<ExpectFlag, 'shouldFlag'>[]): Mutation {
  return {
    id: 'clean-baseline',
    label: '基线（不改动，全部应通过）',
    apply: () => {},
    expect: allPairs.map((p) => ({ ...p, shouldFlag: false })),
  };
}

/** Append a banned word to a block → deterministic (no-LLM) violation. */
export function injectBannedWord(
  id: string,
  chapterId: string,
  blockId: string,
  word: string,
  ruleId: string,
): Mutation {
  return {
    id,
    label: `注入禁用词「${word}」· ${chapterId}`,
    apply: (p) => {
      block(p, chapterId, blockId).text += word;
    },
    expect: [{ chapterId, ruleId, shouldFlag: true }],
  };
}

/** Append a block of prose that violates `ruleId` (head-hop, out-of-character,
 *  ability contradiction, …). The block is the fault; expected = that rule fires. */
export function injectBlock(
  id: string,
  chapterId: string,
  text: string,
  ruleId: string,
  label = `注入违规段 · ${chapterId}`,
): Mutation {
  return {
    id,
    label,
    apply: (p) => {
      chapter(p, chapterId).blocks.push({ id: `${chapterId}-${id}`, text });
    },
    expect: [{ chapterId, ruleId, shouldFlag: true }],
  };
}

/** String-replace inside a block so the prose contradicts canon (prose changes). */
export function contradictInProse(
  id: string,
  chapterId: string,
  blockId: string,
  find: string,
  replace: string,
  ruleId: string,
): Mutation {
  return {
    id,
    label: `正文改为与设定冲突（${find}→${replace}）· ${chapterId}`,
    apply: (p) => {
      const b = block(p, chapterId, blockId);
      b.text = b.text.replace(find, replace);
    },
    expect: [{ chapterId, ruleId, shouldFlag: true }],
  };
}

/** DEPENDENCY CHANGE: flip an element fact (canon), prose untouched. The chapters
 *  whose prose asserted the OLD value are now stale → should fire. */
export function changeDependency(
  id: string,
  elementName: string,
  factKey: string,
  newValue: string,
  affected: { chapterId: string; ruleId: string }[],
): Mutation {
  return {
    id,
    label: `依赖改动（${elementName}.${factKey}→${newValue}，正文未改）`,
    apply: (p) => {
      element(p, elementName).facts[factKey] = newValue;
    },
    expect: affected.map((a) => ({ ...a, shouldFlag: true })),
    depChanges: [{ name: elementName, fact: factKey }],
  };
}

/** DEPENDENCY CHANGE (irrelevant): flip an unrelated fact → must stay clean. */
export function changeDependencyIrrelevant(
  id: string,
  elementName: string,
  factKey: string,
  newValue: string,
  control: { chapterId: string; ruleId: string }[],
): Mutation {
  return {
    id,
    label: `依赖改动（无关：${elementName}.${factKey}→${newValue}）`,
    apply: (p) => {
      element(p, elementName).facts[factKey] = newValue;
    },
    expect: control.map((a) => ({ ...a, shouldFlag: false })),
    // Irrelevant changes ALSO get hinted — so we measure whether the hint itself
    // induces a false positive (the FP guard, under hint).
    depChanges: [{ name: elementName, fact: factKey }],
  };
}
