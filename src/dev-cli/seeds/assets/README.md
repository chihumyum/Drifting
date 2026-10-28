# Original synthetic development assets

These files are original geometric illustrations and fictional documents made
for Drifting development. They contain no external photography, private text,
real measurements, account data or bundled third-party fonts. Project-owned
source and fixtures use the repository's AGPL-3.0-or-later license.

- `island-map.png`: a fictional island atlas.
- `lighthouse.png`: a geometric lighthouse/light-beam study.
- `tide-chart.png`: a curve built from a sine function, not real tide data.
- `ship-log.png`: five fictional observations.
- `field-guide.pdf`, `tide-notebook.pdf`: three-page documents for PDF navigation
  and material annotations. All six pages were rendered and visually inspected.
- `*.display.jpg` / `*.thumbnail.jpg`: prebuilt preview variants; no codecs or
  downloads are required when seeding.
- `manifest.json`: generated source sizes, dimensions and SHA-256 hashes for
  source and preview bytes. Do not edit it by hand.

To recreate the fixtures, with Python Pillow, ReportLab and Poppler installed:

```bash
python3 scripts/generate-seed-assets.py
```

The generator uses built-in Pillow/ReportLab fonts and ReportLab's invariant PDF
mode. Regenerate the manifest together with its bytes; rendering versions can
change JPEG/PDF hashes. Creation never reads personal material or any network.
The checked-in corpus is under 0.5 MiB. Each seeded profile receives its own
copies under its generated native app identifier; the repository files remain
unchanged.

Machine acceptance:

```bash
pnpm exec vitest run src/dev-cli/seed.integration.test.ts src/renderer/platform/worktree-dev-launcher.acceptance.test.ts
```

This exercises actual SQLite, Yjs and on-disk source/variant/object bytes plus
runtime conversation recovery. It does not establish native WebView preview,
picker/codecs, Hosted transfer, physical-device or model-provider acceptance.
