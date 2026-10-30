import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const preflightPseudoElements = require(resolve(root, 'scripts/postcss-preflight-pseudo-elements.cjs'));

// A universal ::before/::after rule makes WebKit resolve both pseudo-elements
// of every element it restyles. Tailwind's preflight is the only one.
describe('preflight without universal pseudo-element rules', () => {
  // A production build lets Tailwind's own optimizer rewrite the selectors
  // first (`:after`, a separate ::file-selector-button rule).
  it.each([false, true])('drops ::before and ::after from the built preflight only (optimize %s)', async (optimize) => {
    const tailwind = require('@tailwindcss/postcss');
    const from = resolve(root, 'src/styles/index.css');
    const { css } = await postcss([tailwind({ optimize }), preflightPseudoElements()]).process(readFileSync(from, 'utf8'), { from });
    const built = postcss.parse(css);
    const universalPseudo: string[] = [];
    let preflight = false;
    built.walkRules((rule) => {
      const selectors = rule.selectors.map((selector) => selector.trim());
      let borderBox = false;
      rule.walkDecls('box-sizing', (decl) => { borderBox ||= decl.value === 'border-box'; });
      if (selectors.includes('*') && selectors.includes('::backdrop') && borderBox) preflight = true;
      // Tailwind's own fallback for engines without @property stays as is.
      if (rule.parent?.type === 'atrule' && (rule.parent as postcss.AtRule).name === 'supports') return;
      if (selectors.some((selector) => /^::?(before|after)$/.test(selector))) universalPseudo.push(rule.selector);
    });
    expect(preflight).toBe(true);
    expect(universalPseudo).toEqual([]);
  }, 60_000);

  it('runs after Tailwind in the PostCSS config', () => {
    const config = readFileSync(resolve(root, 'postcss.config.cjs'), 'utf8');
    expect(config.indexOf("require('@tailwindcss/postcss')")).toBeLessThan(config.indexOf("require('./scripts/postcss-preflight-pseudo-elements.cjs')()"));
  });

  it('leaves no sized pseudo-element with a border or padding relying on the reset', () => {
    const size = /^(width|height|min-width|min-height|max-width|max-height|inline-size|block-size)$/;
    const box = /^(padding|padding-(top|right|bottom|left|inline|block)(-start|-end)?|border|border-(top|right|bottom|left)|border-width|border-(top|right|bottom|left)-width)$/;
    const offenders: string[] = [];
    const styles = resolve(root, 'src/styles');
    for (const file of readdirSync(styles).filter((name) => name.endsWith('.css'))) {
      postcss.parse(readFileSync(join(styles, file), 'utf8')).walkRules((rule) => {
        if (!rule.selectors.some((selector) => /::?(before|after)\b/.test(selector))) return;
        const decls = new Map<string, string>();
        rule.walkDecls((decl) => { decls.set(decl.prop, decl.value.trim()); });
        const sized = [...decls].some(([prop, value]) => size.test(prop) && !/^(auto|none)$/.test(value));
        const boxed = [...decls].some(([prop, value]) => box.test(prop) && !/^(0|0px|none)$/.test(value));
        if (sized && boxed && !decls.has('box-sizing')) offenders.push(`${file}: ${rule.selector}`);
      });
    }
    // The gap cursor from Tiptap sets only a width and a top border.
    expect(offenders).toEqual(['tiptap-base.css: .ProseMirror-gapcursor:after']);
  });
});
