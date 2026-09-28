# Database recovery (恢复)

When the lab's workspace database does not open, the Mac shows a 恢复 window
instead of the workspace, following the renderer's
`DatabaseRecoveryBoundary`. It keeps the public alpha rule: an upgrade that
stops leaves the previous database untouched, nothing opens, and the author
is told what to do. Native only; no Tauri interoperability is kept.

## Bridge contract

- `workspaceOpen` fails with `database-recovery:<session>:<code>` when an
  upgrade stopped before activation; the active database is untouched and a
  verified safety copy with a recovery receipt exists. Any other failure is
  a plain message.
- `workspaceRecovery {directory, command}` works on the same lab directory
  and is refused while a workspace is open there. `command.action`:
  `status {error}` reads the failure (`code`, `recoverySessionId?`,
  `sourceVersion?`, `targetVersion`, `safetyBackup? {backupId, sha256,
  sizeBytes, createdAtMs}`; a plain failure is `database-open-failed`
  without a session or copy); `restore {recoverySessionId, backupId}`
  rebuilds the database from the verified copy (migrating it again in a
  shadow copy) and activates it, only after an open of that directory failed
  in this process; `backupFile` and `backupFolder` name the verified copy and
  its folder. Retrying is `workspaceOpen` again.
- Debug builds (the lab bridge is one) fail inside the shadow migration when
  `DRIFTING_TEST_DATABASE_FAULT_STAGE=migration` is set and the open takes
  the upgrade path, which it does when
  `<lab>/safety-backups/apple-native-workspace.db.last-version` is missing or
  names another version.

## Native behaviour

`LabWorkspaceCore` keeps the failure of its last open: later reads refuse
with it instead of opening again, and only 重试 or a restore open. AppDelegate
opens through `DatabaseRecoveryCoordinator` at launch and on every reopen;
the main window shows only once the workspace opened. On an open failure the
main window, 项目书架 and 诊断摘要 close, menu commands other than 设置 and 退出
are off, and 退出 needs no workspace close.

The window says 升级本地资料库时停止，之前的资料库保持原样 (a recovery session)
or 无法打开本地资料库, the error code, the versions (未知 for an unknown earlier
version) and the safety copy's size, time and first 12 hex digits of its
SHA-256.

- **重试** opens again; a failure re-reads the status and says so.
- **恢复安全副本…** asks first (取消 writes nothing), saying the library is
  rebuilt from the copy made before the upgrade; then restores and opens.
  A failure is again a recovery failure and updates the window.
- **导出安全副本…** copies the verified file through a save panel
  (`Drifting-database-safety-<first 16 of backupId>.sqlite`), beside the
  destination first, and keeps it only when its SHA-256 matches; the copy
  in `safety-backups/` is never moved.
- **在访达中显示** opens the folder that holds the copy.
- **拷贝诊断信息** copies JSON with the code, versions, the opaque recovery
  session and whether a copy exists, plus app and macOS versions and
  architecture: no path, title, backup identity or hash.
- **退出** quits. Buttons that need a copy (or its session) are off without one.

## Acceptance

`--recovery-home-only` in `native/apple/Tests/RecoveryHomeAcceptance.swift`
([binding report](acceptance/p2b-binding.json)) creates a synthetic lab with a
chapter, closes it, removes the marker and sets the fault: the window shows
the status, the database bytes and later reads stay untouched, export equals
the copy and leaves it in place, the folder is the copy's, diagnostics hold
no path or title; 重试 with the fault still set updates the window;
restore after 取消 and 恢复 opens the project with its chapter text; a
second failure is opened by 重试 once the fault is gone; a plain failure
turns the copy buttons off. The variable is unset on every exit.
