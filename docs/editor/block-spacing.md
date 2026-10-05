# Editor block spacing

Body paragraphs and H1/H2/H3 use the same spacing: zero top margin and a shared
bottom margin controlled by Settings → Editor → Paragraph spacing. The existing
preference remains in body-font em; `applyEditorPreferences` resolves it to pixels
using the body font size so headings do not enlarge the gap with their own size.
Zero and fractional values remain valid. No preference or document migration is
needed, and export formatting is unchanged.

The rule covers chapter/idea prose, static all-chapters prose, entity long-form
bodies/templates, patch bodies and Settings preview. The preview includes all
three heading levels and shares their chapter typography. Existing heading font
sizes, weights and outline semantics remain. Patch cards and the preview omit the
last block's bottom margin, whether it is a paragraph or heading. Entity title,
summary and UI section spacing are separate from authored prose blocks.

Regenerate renderer evidence with
`pnpm exec node scripts/run-editor-block-spacing-acceptance.mjs`; use `--check`
to verify the saved source fingerprint. The generated
[`acceptance/block-spacing.json`](acceptance/block-spacing.json) records real
Settings number/range controls, persistence/reload/reset and measured block gaps
for every paragraph/heading pair, body sizes 12/17/28px and spacing
0/0.125/1/2.5em at wide/narrow widths. This is synthetic Chromium evidence, not
Tauri window, physical-device or editing-input acceptance.
