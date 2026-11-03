# Five interface text sizes

As of 2026-11-03, Appearance → Interface text size offers five device-local
choices. Standard is the default for fresh or invalid settings.

| Choice | Previous choice | Body / secondary / caption / emphasis / heading (CSS px) |
| --- | --- | --- |
| 最小 / Smallest | Smaller | Each component's existing fallback |
| 较小 / Smaller | Standard | 14 / 13 / 12 / 15 / 16 |
| 标准 / Standard | Larger | 16 / 15 / 14 / 17 / 18 |
| 较大 / Larger | New | 18 / 17 / 16 / 19 / 20 |
| 最大 / Largest | New | 20 / 19 / 18 / 21 / 22 |

Settings storage v35 maps the three saved choices once, preserving their actual
font sizes and spacing. It does not change SQLite, prose preferences, fonts or
sync scope. The added sizes follow the existing 2px step, including semantic
line heights and control/row/footer heights. Mobile retains CSS fallbacks.

## Reproduce

```sh
pnpm exec vitest run src/renderer/store/settings-store-appearance.test.ts
node scripts/run-interface-text-sizes.mjs
node scripts/run-interface-text-sizes.mjs --check
```

The runner builds a synthetic component fixture with real AppearancePanel,
GlassSlider, body-portaled menus and application styles. It uses a temporary
headless Chromium profile, without loading any application database or projects.
For native acceptance, use `pnpm dev:worktree --no-watch` and the isolated profile
described in [worktree development](../worktree-development.md).

[Generated evidence](interface-text-sizes.json) records 40 combinations: both
languages, both themes, all five sizes, and 1280×800 / 800×800 viewports. Checks
cover exact labels and order, clicking each choice, immediate selection and CSS
updates, versioned persistence, semantic font sizes and spacing, portal
inheritance, control and settings-row containment, unchanged 21px prose and
mobile fallbacks. Full page reloads restore Largest at both widths. The store
tests additionally cover migration from v30/v34, reloading without a second
remap, every new choice, missing/invalid values and independent prose preferences.

The 800px Chinese Largest screenshot was visually checked. This is browser
component evidence; native WKWebView rasterization, populated workspaces and
sidebar dragging were not exercised for this change. Earlier three-size layout
measurements remain in [desktop typography](desktop-typography.md).
