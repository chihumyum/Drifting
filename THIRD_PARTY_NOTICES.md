# Third-party notices

Drifting depends on third-party software under its own licenses. The package
manager lockfiles and Cargo metadata are the authoritative version inventory;
redistributors must preserve the notices and license texts required by the
versions they ship.

Directly bundled or copied material includes:

The vendored [tao 0.35.3](src-tauri/vendor/tao/VENDORED.md) source retains its
[Apache-2.0 license](src-tauri/vendor/tao/LICENSE). It contains only the upstream
tao#1245 iOS scene lifetime backport; it is not relicensed under Drifting's AGPL.

| Component                                                | Use                                                        | License    | Copyright / source                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| Inter Tight variable font                                | Bundled UI font through `@fontsource-variable/inter-tight` | OFL-1.1    | Copyright 2022 The Inter Project Authors; <https://github.com/rsms/inter-tight> |
| Newsreader variable font | Desktop structural titles through `@fontsource-variable/newsreader` | OFL-1.1 | The Newsreader Project Authors; notice in `LICENSES/fonts/newsreader.txt` |
| Source Sans 3 variable font | Desktop entity text through `@fontsource-variable/source-sans-3` | OFL-1.1 | Adobe; notice in `LICENSES/fonts/source-sans-3.txt` |
| Noto Serif SC / Noto Sans SC variable fonts | Desktop Chinese structure and entity text through Fontsource | OFL-1.1 | Noto / Source Han contributors; notices in `LICENSES/fonts/noto-serif-sc.txt` and `noto-sans-sc.txt` |
| Sarasa Mono SC Regular 1.0.43 | Desktop index and metadata; full-font WOFF2 format conversion | OFL-1.1 | Renzhi Li and upstream contributors; complete notice in `src/assets/fonts/sarasa-mono-sc/LICENSE` |
| Android Gradle wrapper scripts and vendored JAR (8.14.3) | Generated Android build wrapper                            | Apache-2.0 | Gradle authors; source: <https://github.com/gradle/gradle/tree/v8.14.3>         |

Major runtime dependency families include Tauri, React, Tiptap/ProseMirror,
Yjs, Drizzle, SQLite/rusqlite, Tokio, reqwest, Zustand, TanStack Query, Lucide,
JSZip, PDF.js, and their transitive dependencies. They are not relicensed by
Drifting. The committed pnpm lockfile and Cargo lockfile are the current
machine-readable inventories. Binary distributors must generate and review
complete notices for the exact release artifact; `pnpm public:check` verifies
repository boundaries, not every transitive license obligation.

The full OFL text for Inter Tight is in `LICENSES/OFL-1.1.txt`. The MIT text
used by Iconoir is in `LICENSES/MIT.txt`. Apache-2.0 is reproduced at
`packages/prose-metrics/LICENSE`. MPL-2.0 dependencies remain under MPL-2.0;
their unmodified package source and notices are available from the locked
upstream packages.

Project-owned and generated asset origins are recorded in
[ASSET_PROVENANCE.md](ASSET_PROVENANCE.md).

Names and trademarks of third-party providers belong to their respective
owners. Their appearance describes compatibility and does not imply
affiliation or endorsement.
# Vendored Yrs

`vendor/yrs` contains Yrs 0.28.0, copyright its upstream authors, under the MIT
license retained in `vendor/yrs/LICENSE`. Its provenance and local correctness
patches are recorded in `vendor/yrs/UPSTREAM.json` and `DRIFTING_PATCHES.md`.

## Native original-operation verification

The shared Rust core uses `ciborium-io` and `ciborium-ll` 0.2.2 for its CBOR
reader. Both are copyright Nathaniel McCallum and contributors, licensed under
Apache-2.0; their source and license are available from
[enarx/ciborium](https://github.com/enarx/ciborium). Their locked runtime
dependencies include `half` 2.7.1 (MIT OR Apache-2.0,
[half-rs](https://github.com/VoidStarKat/half-rs)) and `crunchy` 0.2.4 (MIT,
[crunchy](https://github.com/eira-fransham/crunchy)). The test fixtures use
`base64` 0.22.1 (MIT OR Apache-2.0,
[rust-base64](https://github.com/marshallpierce/rust-base64)). These dependencies
retain their upstream licenses; binary redistribution must include the notices
required by the exact locked packages.

## Manuscript export

PDF export ([docs/manuscript-export.md](docs/manuscript-export.md)) uses
[krilla](https://github.com/LaurenzV/krilla) 0.8.2 (MIT OR Apache-2.0) with its
locked font and PDF stack: `pdf-writer` 0.15.0, `subsetter` 0.2.6 and
`xmp-writer` 0.3.3 from the Typst project; `skrifa` 0.42.1, `read-fonts`
0.39.2, `write-fonts` 0.48.1 and `font-types` 0.11.3 from Google Fonts'
fontations; `kurbo` 0.13.1, `euclid` 0.22.14, `polycool` 0.4.0, `zune-jpeg`
0.5.15, `zune-core` 0.5.3, `gif` 0.14.2 and `imagesize` 0.14.0 (all MIT and/or
Apache-2.0, `zune-*` also Zlib); `tiny-skia-path` 0.12.0 (BSD-3-Clause);
`arrayref` 0.3.9 (BSD-2-Clause); `float-cmp` 0.9.0 and `strict-num` 0.1.1 (MIT).
Text shaping uses [rustybuzz](https://github.com/harfbuzz/rustybuzz) 0.20.1
(MIT, a port of HarfBuzz) with `unicode-script`, `unicode-ccc`,
`unicode-properties` and `unicode-bidi-mirroring` (MIT/Apache-2.0); line breaking
uses [unicode-linebreak](https://github.com/axelf4/unicode-linebreak) 0.1.5
(Apache-2.0). EPUB and Word packages are written with the already locked `zip`
4.6.1 (MIT). None of these is relicensed by Drifting.

Exported PDFs embed subsets of fonts installed on the author's computer. A face
whose OS/2 `fsType` forbids embedding or subsetting is skipped; the embedded
glyphs stay under that font's own license. Drifting bundles no font for PDF
export.
