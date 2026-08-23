# Mobile V2 M0 iOS Simulator baseline — 2026-08-23

Status: **M0 baseline passed; no Mobile V2 interaction implementation claimed**

## Checkout and target

- Source baseline: `60df1bab98bbafea693a476cca7778956832cb16`
- Target: existing `iPhone 16e`, iOS 26.1 Simulator
- Build mode: local-only debug
- Synthetic Project: `M0 Mobile V2 Baseline`

The M0 documentation and acceptance-test changes do not alter renderer product
behavior, so the app binary is the source baseline plus local-only development
configuration.

## Command

```bash
VITE_LOCAL_ONLY_MODE=true VITE_REQUIRE_AUTH=false \
  pnpm mobile:ios:debug -- --device <existing-simulator-udid>
```

The Tauri/Xcode build completed with `BUILD SUCCEEDED`, installed, and launched.
The command was stopped normally after visual acceptance; its final lifecycle
exit is therefore the expected interrupted dev-server exit, not a build failure.

## Observed path

1. A previously used iPhone Simulator reached the native migration recovery
   screen for an older development database and reported
   `migration-state-statement-failed`. The screen exposed retry, restore safety
   snapshot, export safety snapshot, diagnostics, backup-directory, and exit
   actions. No reset or destructive recovery action was taken.
2. An already installed, clean iPhone 16e Simulator was reused instead of
   creating another device or downloading another runtime.
3. The Public Alpha local-first disclosure rendered inside safe areas.
4. Choosing local mode reached the mobile Project shelf without a Drifting
   account.
5. The empty shelf rendered search, filters, settings/avatar, new-Project, and
   empty-state controls without clipping.
6. Creating the synthetic Project reached its Dashboard paper.
7. The Dashboard respected the top safe area and the current bottom paper
   cluster remained above the Home indicator.
8. Tapping the current cluster opened paper overview with exactly one Dashboard
   paper plus separate entries for Element Panorama, Story Graph, and
   TODO/Material Super Views.

## M0 conclusion

This run establishes only that the current checkout still builds and its
existing local-first shelf, Project creation, Dashboard fallback, paper
overview, and independent Super View entry points remain reachable while the V2
contract is frozen.

It does **not** verify the future unified bar, vertical rails, non-scaling panel
geometry, read-state paper swipe, Mobile Agent, complete touch Timeline,
all-chapters mobile editing, portrait lock, expanded-tablet Desktop Shell, dark
V2 layer tokens, Google Drive real account, physical touch, or native lifecycle.

## Storage handling

- No new Simulator device or iOS runtime was created or downloaded.
- The temporary Drifting app/container was uninstalled from the clean iPhone
  16e after the run, and that Simulator was shut down.
- The single existing Drifting Xcode DerivedData directory was approximately
  1.4 GiB after the build. It was retained for incremental reuse by M1 rather
  than creating another build cache; subsequent goals must recheck its size and
  avoid duplicate DerivedData trees.
- The previously used Simulator and its migration recovery data were left
  untouched.
