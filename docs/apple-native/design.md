# Native interaction specification

The native client retains Drifting's five-level act/chapter/scene/beat/note
outline, free-floating drift nodes and nullable primary storyline. Either drift
endpoint makes a drift relation, independently of panel visibility. AppKit and
UIKit use one set of business commands and platform-specific navigation.

- Mac: native window/menu/focus behavior, keyboard-accessible controls, explicit
  tabs and split ownership. The editor keeps selection/scroll per view while
  all views of a document share its authoritative session. Closing a view does
  not close another view's document. Save/recovery state must be visible without
  obscuring ordinary prose collaboration.
- iPhone: one primary writing surface, keyboard-aware controls and continuous
  navigation. Drifting's top/bottom-bar product semantics remain its own; no
  automatic substitution of a browser navigation model. Swiping, selection and
  scrolling must not steal each other's gestures.
- iPad: auxiliary writing/search/comment scope matches iPhone initially. A
  expanded workspace and multiple windows require separate design and tests;
  they are not implied by the first UIKit shell.
- Text: system text services, Chinese composition, emoji, selection across
  blocks, paste and accessibility are first-class. Dynamic Type is supported on
  mobile. Desktop font/writing preferences stay out of CRDT content.
- Inspector/materials: use spacing, typography and background washes for
  hierarchy. Avoid inset-left accent bars. Native popovers use system anchoring;
  the existing body-portal rule continues to govern the old web renderer only.
- Settings: platform-native grouping, provider-neutral labels, recoverable
  failures and credential separation. Keep hosted official-service features
  outside this public local-first client boundary.
- P1 lab: project name, save and reopen only, with clear synthetic-data scope.
  P2 adds a single editor and then a second view for ownership validation.
  Performance/ABI/debug details belong in diagnostics and evidence, not the
  writing controls.
