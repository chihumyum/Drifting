# Milestone J exit report — Native and endurance acceptance

Date: 2026-08-02

Status: **complete for automated scope**

## Native evidence

- Tauri iOS `aarch64-sim` debug archive completed with the production renderer
  build and no signing requirement.
- Tauri Android `aarch64` universal debug APK completed with the production
  renderer, Rust Agent runtime and native MCP HTTP host.
- [`milestone-j-native-build.json`](milestone-j-native-build.json) verifies and
  hashes the Mach-O arm64 executable and 222,936,577-byte APK, bundle id,
  packaged arm64 Rust library and Tauri config.
- Interactive device launch/visual/touch acceptance was deliberately not run:
  build evidence is not mislabeled as UI evidence, and repository policy leaves
  that eyeballing to the user.

## Endurance evidence

- [`milestone-j-4h-soak.json`](milestone-j-4h-soak.json): 16/16 fresh-process
  epochs, 240 logical minutes, passed.
- [`milestone-j-12h-soak.json`](milestone-j-12h-soak.json): 48/48 fresh-process
  epochs, 720 logical minutes, passed.
- The 12h series peaked at 186,138,624 bytes maximum resident set and showed no
  monotonic epoch growth. Every epoch exercised local real-book read-only
  evidence plus restart, corrupted/lost acknowledgement, continuation,
  concurrency, MCP session/cancel and durable-grant fault paths.
- These are accelerated 15-minute workload-equivalent epochs, not a claim that
  this process slept for twelve hours. The same resumable harness supports true
  cadence with `--wall-clock` when thermal/background-timer investigation is
  required.

Normative scope and commands are in
[`../native-endurance-acceptance.md`](../native-endurance-acceptance.md).

## Regression

Milestone I/J changes passed 141 Core files and 886/886 tests, root typecheck
and lint with no errors, generated capability drift checks, and 47/47 native
Rust tests. Mobile builds exposed only upstream/generated deprecation warnings;
no build error remained.

## Remaining product boundary

Subagent orchestration is intentionally outside the single-Agent target.
Physical-device visual/touch/keyboard/background-suspension judgment remains an
explicit manual product check, not unfinished runtime implementation.
