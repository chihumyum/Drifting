# Desktop typography acceptance

The desktop UI uses readable semantic sizes following Apple's [Typography](https://developer.apple.com/cn/design/human-interface-guidelines/typography) guidance. Standard remains the default, with body/secondary/caption roles of 14/13/12 CSS px; Larger adds 2px. Smaller restores each component's original font size through its existing fallback: menu 12.5px, panel tab 11.5px, footer 10px, settings description 12px and section heading 10px. It keeps Standard's spacing and improved contrast. These are product choices, not a pt-to-px conversion or a claim of native Dynamic Type support.

## Reproduce

1. Run `pnpm dev:worktree --instance typography --no-watch`. Use the isolated profile's reported `devUrl`; no daily-use database or manuscript is needed.
2. Open `/scripts/desktop-typography-ui.html` on that origin. The fixture uses real settings, panel-tab, two independent Agent panels and body-portaled menu components, application CSS and synthetic text. Add `?locale=en` for English; the default fixture is Chinese.
3. At 1280×720 and 800×720, press **Run layout checks**. The page measures both themes and all three text sizes. Save the unmodified JSON from `#typography-result` (also offered by **Download report**).
4. Record and check the two generated reports:

```sh
node scripts/check-desktop-typography.mjs --record /tmp/typography-wide.json /tmp/typography-narrow.json
node scripts/check-desktop-typography.mjs --check
pnpm exec vitest run src/renderer/store/settings-store-appearance.test.ts src/renderer/components/menu-surface-style.acceptance.test.ts src/renderer/components/workspace-surface-language.acceptance.test.ts src/renderer/components/leftBars/element-panel-compact-index.acceptance.test.ts src/renderer/components/rightBars/review-panel-sticky-rail.acceptance.test.ts
```

The checker verifies the fixture/source fingerprint, both viewport sizes, expected menu/footer/tab/description/heading sizes, menu wrapping and viewport containment, settings-row overflow, text-control height, body portal inheritance, footer/overlay alignment, unchanged 21px manuscript text, mobile fallback, Agent message/composer/thinking/tool/caption/heading/code sizes in both panes, 1.4 body/composer line height, natural composer resizing, long-code horizontal scrolling, pane overflow, and at least 4.5:1 status-text contrast. Store tests cover old/malformed settings, Smaller/Larger persistence, resetting the UI size and preserving manuscript preferences.

## Observed 2026-10-01

The [generated browser evidence](desktop-typography.json) passes all twelve desktop combinations and the mobile-fallback probes. Measured Smaller/Standard/Larger footer heights are 24/24/26px, and status-text contrast remains 4.93:1 in light appearance and 8.58:1 in dark appearance. The distinct original font sizes restored by Smaller match the values above. The three-option Chinese setting was visually inspected at 800px, including selecting Smaller. Agent conversation probes cover both panes in all twelve combinations, including changing the size of an existing multiline draft.

This is representative browser component/layout evidence, not full native-app or accessibility certification. The isolated Tauri build launched successfully, but the available UI tool could not attach to its unbundled development process. Native WKWebView rasterization and a populated project with real tab dragging, timeline density and all sidebar combinations remain manual checks. The Apple native migration remains paused.
