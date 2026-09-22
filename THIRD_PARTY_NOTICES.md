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
| Iconoir `page-flip`                                      | Copied SVG path in `IconoirPageFlip.tsx`                   | MIT        | Copyright 2021 Luca Burgio; <https://github.com/iconoir-icons/iconoir>          |
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
