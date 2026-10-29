# Asset provenance

This file records the origin and license boundary of assets copied into the
Drifting source tree. Do not remove an entry when regenerating a derivative.

## Drifting app icon

The project maintainer created the canonical raster source in June 2026 with
the assistance of an AI image-generation service and selected, edited, and
packaged it for Drifting. The canonical repository source is
`src/assets/icon.icon/Assets/icon-source.png`; platform icons and the Android
foreground asset are derivatives generated from it.

The maintainer includes the icon with the AGPL-covered client and represents
that they have the rights needed to distribute it on those terms. AI-generated
outputs may not be unique. Copyright permission does not grant permission to
present a fork as the official Drifting product; see [TRADEMARKS.md](TRADEMARKS.md).

## Sand and glass masks

`src/assets/design/` holds alpha masks for the interface's two materials
(sand marks, glass rims) and its brush-drawn icons. They were generated
procedurally for Drifting in October 2026; the generators are in
`scripts/design-assets/`, which lists each output and its script. The
brush-drawn icons for the chapter end, the dock, the user menu and the
smaller action, object and state icons come from `brushicons.py` with fixed
seeds. They are original project assets under the
client's AGPL-3.0-or-later terms.

## Desktop semantic fonts

Newsreader 5.3.0, Source Sans 3 5.3.1, Noto Serif SC 5.3.1 and Noto Sans SC
5.3.1 are supplied by their corresponding `@fontsource-variable` packages.
They retain OFL-1.1 and their notices in `LICENSES/fonts/`.

Sarasa Mono SC Regular comes from the upstream
[1.0.43 release](https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43),
`SarasaMonoSC-TTF-Unhinted-1.0.43.7z`. The complete font was converted with
`python -m fontTools.ttLib.woff2 compress SarasaMonoSC-Regular.ttf` without
subsetting or glyph edits. Its license, source and output SHA-256 hashes are
retained beside the bundled WOFF2 in `src/assets/fonts/sarasa-mono-sc/`.
This font remains OFL-1.1, not AGPL.

## Inter Tight mobile fallback

The bundled Inter Tight variable font is supplied through
`@fontsource-variable/inter-tight`. It remains under OFL-1.1 and is not
relicensed as AGPL. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
`LICENSES/OFL-1.1.txt`.

