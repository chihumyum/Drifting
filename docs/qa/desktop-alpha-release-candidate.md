# Desktop Alpha release-candidate acceptance

Status: **NOT RUN — signed RC required**

Record: date, operator, Apple Silicon model/RAM, macOS version, exact commit,
tag, downloaded DMG SHA-256, install state, timings, and sanitized evidence.

## P0 data and distribution

- [ ] Fresh install creates a local project without a Drifting account.
- [ ] Continuous writing, Chinese IME, undo/redo, window close, `Cmd+Q`, force
      quit, offline restart, and app restart preserve the unique canary.
- [ ] Images and PDFs import, replace, render after restart, and delete cleanly.
- [ ] Image/PDF picker, copy/preview/hash verification, and failure recovery
      expose a visible progress state; the create action never appears merely
      disabled while native work is running.
- [ ] Relational Markdown exports readable content.
- [ ] Native asset import/replace fault injection and force quit expose only the
      complete old asset or complete new asset; restart GC follows SQLite inventory.
- [ ] A migration failure preserves the original database, blocks startup, and
      exposes the internal SQLite safety-snapshot recovery entry.
- [ ] Real N-to-N+1 shadow migration survives kill at snapshot, candidate,
      migration, validation, fsync, replace, and marker boundaries without
      migrating the active database in place.
- [ ] Downloaded DMG passes SHA-256, Developer ID, `codesign --deep --strict`,
      Gatekeeper `spctl`, notarization staple, read-only mount, and first launch.
- [ ] `alpha.1` updates to signed `alpha.2` only after user confirmation;
      projects, assets, Drive authority, and BYOK survive, and any required
      data migration passes the shadow-migration gate on first launch.

## P1 desktop experience

- [ ] Onboarding covers local project, optional Drive/local-only choice, and
      the quick guide without presenting an app-managed backup workflow.
- [ ] Google Drive connect, reauthorize, cancel, pause/resume, and disconnect
      show an immediate live operation state. Disconnect explains its final
      convergence/revoke wait and ends with either local-only confirmation or
      an actionable inline error.
- [ ] Chapter/timeline drag, relationships, Story Graph, and Plot Grid work
      through restart.
- [ ] Keyboard navigation, focus order, Escape, modals, titlebar, menus, and
      light/dark appearance have no blocking defects.
- [ ] DeepSeek, Anthropic, and OpenAI each pass one disposable BYOK smoke;
      accept, reject, credential revoke, and restart do not corrupt prose.
- [ ] User-generated diagnostics contain no manuscript, OAuth/BYOK secret, or
      absolute path and are never uploaded automatically.
- [ ] On an M1/8GB machine: cold start to interactive <=4 s, open 50k Chinese
      characters <=3 s, and input-to-paint p95 <=50 ms.

Mobile, Intel Mac, Windows, and Linux results are explicitly out of scope.
