# Standalone Apple front-end retired

Retired by the author on 2026-10-28. Tauri is the supported client.

The standalone Swift/AppKit/SwiftUI/UIKit project, Apple-only Rust bridge,
fixtures, build scripts, migration gates and acceptance reports have been removed
from the active tree. The paused experiment is recoverable from Git tag
`apple-native-paused-2026-09-29`; Git history also retains later cleanup inputs.

`crates/drifting-core`, `crates/drifting-document` and `crates/drifting-prose`
remain dependencies of the supported Tauri client. Tauri's macOS/iOS adapters,
ImageIO support, OS secure storage, signing configuration and iOS project are
also retained. They are not the abandoned front-end.

See [current onboarding and Hosted readiness](../client-onboarding-and-hosted-readiness.md).
