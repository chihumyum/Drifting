# Windows preview

Status: **preview builds only.** Drifting's public releases are still macOS
(Apple Silicon). Windows installers are built by
[`.github/workflows/windows.yml`](../.github/workflows/windows.yml) on every
push to `claude/windows-port` or a `windows/**` branch, and are not published.

## Builds

| Job | Runner | Result |
| --- | --- | --- |
| `windows / rust tests` | `windows-latest` (x64) | `cargo test --lib` for the Tauri crate on Windows |
| `windows / developer commands` | `windows-latest` (x64) | the contributor commands below: install, typecheck, lint, tests, launcher manifests, developer CLI |
| `windows / installer (x64)` | `windows-latest` | unsigned NSIS installer, Hosted sign-in enabled; installed and opened on the runner |
| `windows / installer (arm64)` | `windows-11-arm` | the same for Windows on Arm |

Each installer job installs its installer silently, opens Drifting and fails
when the App is no longer running 20 seconds later, printing what it wrote to
standard error; an installer is uploaded only after it opened. A signed
updater that cannot start (for example a build whose configuration lacks
`plugins.updater`) no longer stops the App: Drifting opens and only its update
check reports the reason.

Each installer is a workflow artifact named
`drifting-windows-<arch>-<commit>` and kept for 14 days. Windows installers can
only be built on Windows; the macOS checkout never cross-compiles them.

The installer is per user (`installMode: currentUser`): it needs no
administrator rights, installs under `%LOCALAPPDATA%`, and registers the
`drifting:` link for sign-in. Its pages are in Simplified Chinese or English.
It is not Authenticode-signed, so Windows SmartScreen may show "Windows
protected your PC" on first launch (More info → Run anyway). Preview builds
compile the updater public key in but sign no updates of their own
(`DRIFTING_UPDATER_ARTIFACTS=off`): an installed preview updates to the next
published release that ships Windows. Installing an update saves every local
write first; the updater then quits Drifting, runs the installer in passive
mode and reopens it.

To build and run Drifting from source on Windows, see
[Developing on Windows](#developing-on-windows).

## What differs on Windows

- **Wording.** Strings that name the Mac's own things ("this Mac", Finder,
  Keychain, the Apple Silicon build) have Windows wording in
  `src/renderer/locales/windows/<locale>.json`: "this PC", File Explorer,
  Windows Credential Manager, "Windows 10/11 · x64 and ARM64".
  `applyPlatformCopy` overlays them before the first render; Apple platforms
  keep the base strings. `windows-copy.acceptance.test.ts` requires every
  string in all nine languages that names a Mac thing to have Windows wording.
- **Shortcuts.** `Mod` is Ctrl. Fixed hints written for the Apple keyboard go
  through `platformShortcut('⌘↩', 'Ctrl+Enter')`; configurable shortcuts go
  through `formatAccelerator`.
- **Window.** Windows has no native title bar: `windows_webview.rs` turns the
  decorations off (Tauri keeps the window resizable from its edges and keeps
  its shadow), and `WindowsCaption` draws close, minimize and maximize as one
  glass pill in the top-left corner, in the traffic lights' place and order.
  The pill is the paper toolbar's tray without its fill (28px round glass
  buttons, 16px brush icons, 4px tray padding); maximize turns into restore.
  Headers keep `--window-header-leading-inset` (110px on Windows, 94px on
  macOS) clear of it, it sits above dialogs, and immersive writing fades it
  with the sidebar toggles until the pointer reaches the top edge. Close is
  the window's own close request: an open book returns to the shelf; on the
  shelf it saves and hides the window to the notification area. Windows 11's snap layouts flyout on the maximize
  button is gone with the native button; Win+Z and Win+arrow keys still snap.
  `window_set_theme` still sets the window's theme for system surfaces.
- **Fonts.** The interface fonts are bundled, so Chinese and Latin interface
  text matches macOS. The prose system serif falls back to the bundled Noto
  Serif SC rather than SimSun; the system sans names Microsoft YaHei. PDF export
  already lists SimSun and Microsoft YaHei.
- **Secrets.** Model keys and sign-in sessions use Windows Credential Manager
  through `keyring`. One credential holds 2560 bytes of UTF-16, so values
  longer than 1200 characters (the ChatGPT subscription's OAuth tokens, Hosted
  sessions) are split across credentials by `secure_storage::chunked`: the
  head names the generation, part count and SHA-256, a write lands the new
  parts before the head, and a damaged part fails the read. Nothing falls back
  to a file.
- **Browser behaviour.** WebView2's browser shortcuts are off (F5 and Ctrl+R
  no longer reload the interface, Ctrl+P no longer prints, Alt+Left no longer
  navigates; the keys still reach Drifting). Right-click keeps WebView2's
  editing items (cut, copy, paste, emoji, spelling) and drops Back, Reload,
  Save as, Print and the other browser items (`windows_webview.rs`).
- **HEIC, HEIF and AVIF** decode through the Windows Imaging Component, as
  macOS uses ImageIO (`windows_image_codec.rs`). WIC needs the Store codecs:
  HEIF Image Extensions with HEVC Video Extensions for iPhone photos, AV1
  Video Extension for AVIF. Without them the material dialog says so and
  offers the Store page (`lib/windows-image-codecs.ts`). HEVC carries patent
  licensing, which is why Drifting does not ship a decoder of its own.
- **Durability.** Windows has no directory fsync. File replacement uses
  `MoveFileExW` with `MOVEFILE_WRITE_THROUGH`; the directory barrier
  (`sync_directory`) validates the directory and relies on NTFS journaling.
- **Markdown folder.** Reserved names (`CON`, `PRN`, …) are already avoided.
  Unix permission and hard-link checks are skipped on Windows.

- **Notification area.** Like the Dock on macOS, Drifting stays running when
  its window closes on the shelf: `windows_tray.rs` puts its icon in the
  notification area, so a background Agent and sync go on. A left click, the
  menu's Open item or launching Drifting again brings the window back; Quit
  saves and ends the process (as an update install does). The menu follows
  the interface language (`tray_set_labels`). Windows 11 may first show the
  icon in the overflow (^) area.

- **External Agents.** Codex, Claude Code and Antigravity connect through the
  same local MCP bridge as on macOS (docs/agent-runtime/local-mcp.md), over
  `127.0.0.1` on a port chosen at each launch instead of a Unix socket; every
  connection file follows the new port, and the token authenticates each
  stream. The clients' files are `%USERPROFILE%\.codex\config.toml` (or
  `CODEX_HOME`), `%USERPROFILE%\.claude.json` and
  `%USERPROFILE%\.gemini\config\mcp_config.json`.
- **MCP servers in Agent extensions** (stdio): an absolute command written
  without its extension finds the `.exe`, `.cmd` or `.bat` beside it; servers
  inherit Windows' system and profile folders (APPDATA, USERPROFILE…), open no
  console window, and stopping one ends its whole process tree.

## Not available on Windows yet

- Authenticode-signed installers.

## Developing on Windows

Windows 10 or 11, x64 or ARM64, can run the development app and the source
checks. Install once:

- **Node.js 22.23.1 or newer** (the official installer), then pnpm through
  Corepack in an administrator terminal: `corepack enable`, then
  `corepack prepare pnpm@10.17.1 --activate`.
- **Rust 1.96** with the MSVC toolchain from [rustup](https://rustup.rs):
  `x86_64-pc-windows-msvc` on x64, `aarch64-pc-windows-msvc` on ARM64.
- **Visual Studio Build Tools** (or Visual Studio) with the **Desktop
  development with C++** workload, which brings MSVC and the Windows SDK. On
  ARM64 also select the ARM64 build tools.
- **WebView2 Runtime.** Windows 11 has it; on Windows 10 install the Evergreen
  runtime if it is missing.
- **Git for Windows.** The launchers call `git` to tell a linked worktree from
  the main checkout. Clone into a short path such as `C:\src\Drifting`: Cargo's
  build folders inside a worktree profile are deep, and Windows limits paths
  to 260 characters unless long paths are turned on.

The repository's `.gitattributes` checks every text file out with LF line
endings whatever `core.autocrlf` says; patches, generated evidence and source
fingerprints depend on it. In PowerShell, quote an `--input '@file.json'`
argument; Windows PowerShell 5.1 also drops the double quotes inside inline
JSON passed to `pnpm drifting`, so give it the JSON as a file there.

These commands work as on macOS:

| Command | Notes |
| --- | --- |
| `pnpm install --frozen-lockfile` | no install scripts beyond esbuild's |
| `pnpm dev`, `pnpm dev:online` | in a linked worktree `pnpm dev` starts its isolated profile |
| `pnpm dev:worktree` with `--print-config`, `--no-watch`, `--instance`, `--port`, `--online`, `--frontend-debug`, `--agent-debug`, `--performance-audit`, `--release-perf` | `--build-app` is macOS only |
| `pnpm dev:seed`, `pnpm dev:seed:lite` | |
| `pnpm tauri:build`, `pnpm tauri:build:debug` | unsigned; add `--bundles nsis` for the installer alone, as CI does |
| `pnpm lint`, `pnpm typecheck`, `pnpm test` | |
| `pnpm ci:contract:check`, `pnpm public:check`, `pnpm agent:capabilities:check`, `pnpm release:check` | |
| `pnpm core:test` | needs the MSVC toolchain |
| `pnpm drifting …`, including `frontend serve --platform desktop` | see [frontend-debug.md](frontend-debug.md) |
| `pnpm frontend:debug:check` | |
| `pnpm dev:check` | checks the macOS signing scripts only; Windows needs no certificate |
| `pnpm dev:commands:check` | starts each tool the launchers use, prints both profile manifests, asks the developer CLI for help and seeds a lite library into a temporary folder; launches no app |

What differs from macOS:

- **No code signing.** `pnpm dev` and local builds need no certificate. The
  signed runner `scripts/run-signed-macos-dev.sh` is Cargo's runner for Apple
  targets only and never runs on Windows.
- **Tools start without a shell.** Node cannot spawn `pnpm.cmd` or another
  `.cmd` shim without a shell (EINVAL), and a shell would re-split paths with
  spaces. On Windows the launchers run each tool's own entry script with Node
  instead of `pnpm exec` (`scripts/package-bin.mjs`); Tauri's
  `beforeDevCommand` still runs `pnpm exec vite` through `cmd`.
- **Stopping a launcher.** Windows has no process groups or catchable
  SIGTERM. Ctrl+C reaches every process in the terminal, and the launcher then
  ends the Tauri CLI's process tree (Cargo, Vite and the app) with
  `taskkill /T /F`. Automation stops a launcher with
  `taskkill /PID <launcher pid> /T /F`.
- **Profile storage.** A worktree profile's App-local data is under
  `%LOCALAPPDATA%\<identifier>`, its WebView2 data persists per profile (macOS
  uses an ephemeral store), and its secrets go to Windows Credential Manager.
- **Not on Windows:** `--build-app`, the iOS commands and
  `frontend serve --platform ios`, `pnpm release:screenshots`, the native
  performance scripts (`perf:stress`, `perf:renderer:native`) and the
  crash-recovery acceptances that need POSIX SIGKILL. Tests that need POSIX
  signals are skipped on Windows. The Android commands are untested there.

## Manual acceptance (Windows 11, including Arm virtual machines)

An x64 installer runs on Windows 11 on Arm through emulation; the arm64
installer runs natively. The interface is the same WebView2 (Chromium) in both.

1. Install without administrator rights; the app opens to the shelf with the
   sample book.
2. Write in a chapter with Microsoft Pinyin: composition, candidate selection,
   Enter and Esc inside a composition, Chinese punctuation, at the start and
   end of a chapter, in a heading, in a comment, in an element body, and in the
   Agent composer.
3. Shortcuts: Ctrl+N, Ctrl+K, Ctrl+, , Ctrl+F in settings, Ctrl+Enter to send,
   Ctrl+Z/Ctrl+Shift+Z in the editor. Hints read Ctrl, never ⌘.
4. Sign in with email and with Google (the browser hands back through the
   `drifting:` link); sync a book; sign out with pending changes.
5. Settings › Models: save a DeepSeek key; it survives a restart (Credential
   Manager).
6. Close a book with the title bar's close button (returns to the shelf); close
   again on the shelf: the window hides and Drifting stays in the notification
   area. Click its icon to bring the window back; quit from its menu, reopen:
   the last edits are there.
7. Turn on the Markdown folder, open it in File Explorer, edit a chapter in
   Notepad, and come back; keep the file open in another editor while Drifting
   writes.
8. Export EPUB, PDF and Word; open the PDF and check Chinese glyphs.
9. Display scaling at 125% and 150%; light and dark themes; immersive writing.
10. The window buttons: close, minimize, maximize/restore; drag the window by
    the empty top row and double-click it to maximize; resize from every edge
    and corner; Win+arrow keys and Win+Z. With a book open, close returns to
    the shelf. In immersive writing the pill appears at the top edge.
11. Press F5, Ctrl+R and Ctrl+P while writing: nothing reloads or prints.
    Right-click on text and on empty paper: only editing items appear.
12. Sign in to the ChatGPT subscription; quit and reopen: still signed in.
13. Import a HEIC photo and an AVIF image (with the Store codecs installed).
14. Connect Codex or Claude Code to a book (Settings › Agent › external
    Agents) and ask it to read a chapter; quit and reopen Drifting, ask again.
15. Add an MCP server that starts with npx in Agent extensions; no console
    window appears, and turning it off leaves no node process behind.
16. Updating: from an installed earlier version (a preview build or the
    previous release), Settings › Updates finds the new release, downloads and
    installs it, and Drifting reopens on the new version with books, account
    and model keys intact.
