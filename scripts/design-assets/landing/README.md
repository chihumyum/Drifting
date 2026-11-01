# Landing page

drifting.cc's home page, built as a static directory that the site repository
(Drifting-Showcase) serves beside its `/privacy`, `/terms` and `/support`
pages.

```sh
node scripts/design-assets/landing/build.mjs                       # writes out/landing/
node scripts/design-assets/landing/build.mjs ../site --og card.png # another directory, with the sharing card
```

It writes `index.html`, `assets/` and `fonts/` (and `og.png` with `--og`; use
`social-preview/`'s `dark.png`). Copy the directory's contents into the site's
served directory. The page links `/legal/favicon-32x32.png` and
`/legal/apple-touch-icon.png`, which the site already serves for its
information pages.

What is on the page, and why:

- **The sea.** `entry.mjs` bundles the app's own `lib/char-sea`, `sand-frame`
  and `sand-cover` with esbuild. The page passes `CharSeaOptions`: it raises
  DRIFTING instead of "Loading", at 0.4 of the window's height so the tagline
  and buttons fit under it, with heavier characters in the word (`wordInk`) and
  a denser sheet on narrow windows. `charSeaWordBox` places the tagline under
  the word. At the top the word stands in the rain; scrolling lets it go, as a
  book opens. The content sheets lie on the sea like shelf cards, their glass
  drawn by the sea.
- **Corners of the workspace.** Each pillar shows a corner of the real
  desktop window, measured from the app's own components: a page that takes
  Markdown as it is typed beside the `.md` file it is saved to; the left
  sidebar's cells, element categories and the dry frame drawn round a click;
  the Agent's transcript beside a page where its edit erases and types in.
  Each plays over and over while it is in view and rests finished when it is
  not; whatever changes floats over a hidden copy of its tallest state, so the
  page never shifts while one plays. Reduced motion shows them finished.
- **Coloured sand.** The tagline's three pillars are underlined in their
  colours, each section carries its colour in its mark, bullets and one
  highlighted word, and the closing card is a book with its storylines flowing
  down the cover.
- **Copy** comes from the README in both languages; the language switch also
  changes the sea's script. Theme follows the system, or the round button.
- **Nothing from another host.** Fonts are the app's own `@fontsource-variable`
  faces, copied as only the slices holding a character the page or the sea
  writes, under the app's family names so the sea's font stacks find them. The
  site's privacy policy says it loads no third-party resources; keep it true.
