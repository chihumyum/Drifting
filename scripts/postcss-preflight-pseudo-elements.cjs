/**
 * Drops `::before` and `::after` from Tailwind's preflight reset.
 *
 * Preflight resets `*, ::after, ::before, ::backdrop, ::file-selector-button`.
 * A universal pseudo-element rule makes WebKit resolve both pseudo-elements of
 * every element whenever it restyles it, which was a third of the style work
 * of mounting a large view. Pseudo-elements already start with no margin or
 * padding and no border; the few that set a size with a border declare their
 * own box-sizing (see docs/renderer-performance/preflight-pseudo-elements.md).
 */
const PSEUDO = /^::?(before|after)$/;

/** The preflight reset, however Tailwind's own optimizer wrote its selectors. */
function isPreflightReset(rule) {
  const selectors = rule.selectors.map((selector) => selector.trim());
  if (!selectors.includes('*') || !selectors.includes('::backdrop')) return false;
  if (selectors.filter((selector) => PSEUDO.test(selector)).length !== 2) return false;
  let borderBox = false;
  rule.walkDecls('box-sizing', (decl) => { borderBox ||= decl.value.trim() === 'border-box'; });
  return borderBox;
}

module.exports = () => ({
  postcssPlugin: 'drifting-preflight-pseudo-elements',
  OnceExit(root) {
    root.walkRules((rule) => {
      if (!isPreflightReset(rule)) return;
      rule.selectors = rule.selectors.filter((selector) => !PSEUDO.test(selector.trim()));
    });
  },
});
module.exports.postcss = true;
