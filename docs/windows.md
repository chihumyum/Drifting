# Windows preview

Status: **preview builds only.** Drifting's public releases are still macOS
(Apple Silicon). Windows installers are built by
[`.github/workflows/windows.yml`](../.github/workflows/windows.yml) on every
push to `claude/windows-port` or a `windows/**` branch, and are not published.

## Builds

| Job | Runner | Result |
| --- | --- | --- |
| `windows / rust tests` | `windows-latest` (x64) | `cargo test --lib` for the Tauri crate on Windows |
| `windows / installer (x64)` | `windows-latest` | unsigned NSIS installer, Hosted sign-in enabled |
| `windows / installer (arm64)` | `windows-11-arm` | the same for Windows on Arm |

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

The desktop runner (`scripts/run-desktop-tauri.mjs`) starts the Tauri CLI with
Node on Windows, because Node refuses to spawn `pnpm.cmd` without a shell.

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
- **Window.** Windows keeps its native title bar. The macOS overlay title bar,
  traffic-light inset and immersive writing's hidden traffic lights apply to
  macOS only. The close button still returns an open book to the shelf; on the
  shelf it saves and quits. The native title bar follows Drifting's own light
  or dark theme (`window_set_theme`, Windows only).
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
  Video Extension for AVIF. Without them the import names what to install.
- **Durability.** Windows has no directory fsync. File replacement uses
  `MoveFileExW` with `MOVEFILE_WRITE_THROUGH`; the directory barrier
  (`sync_directory`) validates the directory and relies on NTFS journaling.
- **Markdown folder.** Reserved names (`CON`, `PRN`, …) are already avoided.
  Unix permission and hard-link checks are skipped on Windows.

## Not available on Windows yet

- External Agents over local MCP (Codex, Claude Code, Antigravity): the bridge
  is a Unix socket; the settings section is hidden on Windows.
- Authenticode-signed installers.

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
   again on the shelf (quits). Reopen: the last edits are there.
7. Turn on the Markdown folder, open it in File Explorer, edit a chapter in
   Notepad, and come back; keep the file open in another editor while Drifting
   writes.
8. Export EPUB, PDF and Word; open the PDF and check Chinese glyphs.
9. Display scaling at 125% and 150%; light and dark themes; immersive writing.
10. Press F5, Ctrl+R and Ctrl+P while writing: nothing reloads or prints.
    Right-click on text and on empty paper: only editing items appear.
11. Sign in to the ChatGPT subscription; quit and reopen: still signed in.
12. Import a HEIC photo and an AVIF image (with the Store codecs installed).
