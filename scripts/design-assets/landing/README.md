# Landing page

drifting.cc's home page and the look the whole site shares, built as a static
directory that the site repository (Drifting-Showcase) serves beside its
`/privacy`, `/terms` and `/support` pages and its 404.

```sh
node scripts/design-assets/landing/build.mjs                       # writes out/landing/
node scripts/design-assets/landing/build.mjs ../site --og card.png # another directory, with the sharing card
```

The build writes nine static home pages, shared assets and fonts, and the
sitemap. Pass `--og` with the sharing card to replace `og.png`. The site
serves its policy and support pages beside the generated homes. The sitemap
reads those pages' English update dates from their HTML.

`locales.mjs` uses the app's language registry and maps its codes to website
paths. English is `/`, Simplified Chinese is `/zh`, Traditional Chinese is
`/zh-tw`, and Brazilian Portuguese is `/pt-br`. The other languages use
`/ja`, `/ko`, `/es`, `/de` and `/fr`.

- `index.html` contains one layout. The `copy/*.json` files supply each
  locale's visible copy, demo text, labels, metadata and installation
  instructions. Write complete phrases and keep the inline links, emphasis,
  entity marks and code samples in their translated context.
- `prefs.js` applies theme and language before paint. The default home
  honors an explicit language hash, then the saved manual choice, then the
  first supported browser language. It preserves query parameters and section
  anchors when it routes to the matching page. Localized URLs retain their
  own language. `/#en` explicitly opens English, including when storage is
  unavailable. Existing `#zh` links and saved `zh` choices still open
  Simplified Chinese.
- The header uses a native disclosure with ordinary language links. Its
  selected name stays on one line, and the full list fits the viewport. The
  list is drawn as the app's menu (`ui-controls.css` `.menu-surface`): 240
  wide, 16px corners on the still glass rim (`glass-ring.png`, drawn as a
  background), 30px rows of 14px words standing in 6px, a glass ring under
  the pointer, and the page's own language in ink-1 with a tick at its end.
  Choosing a language saves the home preference. The support and policy
  pages use their own two-language preference and links into their available
  copy. The home links label this scope in the footer.
- `site.css` shares the app's glass, sand and font roles. The site serves its
  own font files and prefers the matching system families for Traditional
  Chinese, Japanese and Korean glyphs. Korean breaks only between words
  (`word-break: keep-all`). Japanese running text breaks between characters
  under strict rules; headings, the lede and the tagline break only at the phrase
  boundaries their copy marks with `<wbr>` or after punctuation, in every
  browser (not `auto-phrase`, which Safari lacks). Mark new Japanese headings
  the same way. The app's character sea uses the page's language. On narrow screens the primary download links are in the
  hero and closing section.
- **Downloads.** The hero and the closing section each offer the Mac and the
  Windows installer, and the closing install text links the Windows ARM64
  installer. The links name the files of the latest published release
  (`releases/latest/download/Drifting_<version>_macos_arm64.dmg` and
  `…_windows_x64-setup.exe` / `…_windows_arm64-setup.exe`), with the version
  from `package.json`, so build and deploy the site only after that release is
  published. The Mac button leads by default; for a Windows visitor
  (`leadWithVisitorPlatform` in `site.mjs`) the Windows button takes the
  primary glass and leads each row, and the header's Download fetches the
  Windows installer instead of opening the releases page.
- **Stars.** The site cannot star the repository for a visitor (GitHub allows
  that only through an OAuth grant, and the home loads nothing from other
  hosts), so it asks at the moment of download (2026-11-06). The hero's third
  button and the footer link read "Star on GitHub" with the sand star in
  ochre and open the repository. Clicking an installer link (either row, or
  the header's Download when it fetches the installer itself) gives the root
  `.downloaded` (`askForStarOnDownload` in `site.mjs`): in the hero, the note
  "Your download has started. If you like Drifting, star it on GitHub." fades
  in where the line of systems and version stood, in the same grid cell, and
  at the close it shows on a line kept for it, so nothing moves. The star
  count is not shown.
- `site.mjs` owns the language and theme controls and the shared sea
  behavior. The build bundles it into `/assets/landing.js` and
  `/assets/pages.js`.

What is on the page, and why:

- **The sea.** `entry.mjs` bundles the app's own `lib/char-sea`, `sand-frame`
  and `sand-cover` with esbuild. The page passes `CharSeaOptions`: it raises
  DRIFTING instead of "Loading", at 0.4 of the window's height so the lede,
  the tagline and the buttons fit under it, with heavier characters in the word (`wordInk`) and
  a denser sheet on narrow windows. `charSeaWordBox` places the hero under
  the word: first a lede in the interface face saying what Drifting is, then
  the tagline. Both follow the repository's GitHub description (2026-11-06):
  "a cross-platform, AI-native novel-writing app" and the three pillars, ending
  on writing your first bestseller; the Chinese pages say 经典写作工坊的创作框架
  and 贯穿全书的 AI Agent. The rain falls the whole way down (`rain(true)`, as on the app's
  first-run page), changing the characters it passes. At the top the word
  stands in it; scrolling lets the word go, as a book opens. The content sheets
  lie on the sea like shelf cards, their glass drawn by the sea. The
  information pages have the same sea and rain with no word.
- **Corners of the workspace.** Each pillar shows a corner of the real
  desktop window, measured from the app's own components (the tab rows with
  their square glass block, which slides with the panels' push on the app's
  `PUSH_MS` and `PUSH_EASING`, and the sidebar toggle, the pane headers and their
  actions, cells, storylines, category frames, the Agent's conversation row): a page that takes
  Markdown as it is typed beside the `.md` file it is saved to; the left
  sidebar's cells, element categories and the dry frame drawn round a click;
  the Agent's transcript beside a page where its edit erases and types in.
  Panel tabs on both sidebars, storyline names (including Unassigned) and
  element-category headings use the app's structure face: Newsreader with
  Noto Serif SC, normal weight and spacing. Chinese tab labels sit 0.15em
  lower on the Latin line, as in `interface-fonts.css`; group counts keep
  the site's index face (2026-11-02).
  Each plays over and over while it is in view and rests finished when it is
  not; whatever changes floats over a hidden copy of its tallest state, so the
  page never shifts while one plays. Reduced motion shows them finished.
  The `.md` window's title uses an 11px font on a 16px line: its ellipsis
  container clips both axes, and a line as short as the font size clips the
  actual glyphs (including the descender in "Fog"). Keep the line tall enough
  for both languages, centred within the unchanged 30px title bar. The static
  demo converts its cover's alpha masks to PNGs in `entry.mjs`; the app's
  shared `sand-cover` module supplies the masks and dimensions.
- **Coloured sand.** The tagline's three pillars are underlined in their
  colours, each section carries its colour in its mark, bullets and one
  highlighted word, and the closing card is a book with its storylines flowing
  down the cover. The closing cover carries only its artwork, with no title
  initial or genre text over it (2026-11-02).
- **The name in the bar** is written in sand, like the sharing card's
  tagline: `wordmark.sh` renders `wordmark.html` (each letter of DRIFTING
  traced and laid with `social-preview/sand-letters.js`) to
  `src/assets/design/sand/wordmark-drifting.png`, and `site.css` shows it as a
  mask in ink inside the bar's pill. The link keeps the word as text for
  readers and search engines.
- **Questions.** After Your data, a sheet in purple answers what a reader,
  a search or a language model asks first, as plain statements: how Drifting
  differs from Scrivener and Novelcrafter (with a five-row comparison table:
  runs as, price, source, offline, AI), offline use and accounts, price and
  license, AI and models, Obsidian, bringing a Scrivener project, losing and
  backing up a manuscript, sync, systems and languages. Each question is an
  `h3` under the sheet's `h2`, and the first sentence of each answer is the
  answer (a quoting model takes the first sentence or two). `build.mjs` writes
  the same questions and answers into each page's head as FAQPage JSON-LD in
  that page's language. Keep each answer one `<p>` right under its `h3`. Claims about the other two follow what
  their makers say (2026-11-04: Scrivener is bought once and has no AI of its
  own; Novelcrafter is a subscription web app that needs a connection and
  takes your own key or a local model). Since 2026-11-04 the site and README
  may name Scrivener and Novelcrafter. The site's `llms.txt` (written in the
  site repository) carries the same facts; change both together. The English
  page writes language names in English in its body copy. The picker uses
  every language's native name.
- **The version** in the hero's line and the structured data's
  `softwareVersion` is `{{version}}`, filled from `package.json`.
- **The demos** use the page's copy. The raw Markdown and typing animation
  read the same sentences as the static manuscript. The Agent compares a
  localized original with the localized edit. Panel tabs wrap as whole
  labels and the selection block measures the active tab's bounds.
- **Nothing from another host.** Fonts are the app's own `@fontsource-variable`
  faces, copied as only the slices holding a character a page (this one, and
  the information pages already in the directory) or the sea writes, under the app's family names so the sea's font stacks find them. The
  site's privacy policy says it loads no third-party resources; keep it true.
- **For search engines and sharing.** Every home has its own canonical URL,
  localized title and description, sharing metadata, and reciprocal
  `hreflang` links. The English root is `x-default`. Visible FAQ copy and
  FAQPage data come from the same rendering. The build writes the home
  entries to the sitemap together with the information pages.

## Multilingual acceptance

Build into a checkout of Showcase and check its generated site:

```sh
node scripts/design-assets/landing/build.mjs /path/to/Drifting-Showcase/site
node scripts/design-assets/landing/check.mjs /path/to/Drifting-Showcase/site scripts/design-assets/landing/acceptance/multilingual.json
```

The Chromium collector uses an isolated profile and checks real pointer
selection, Escape, the active language, all three demos, layout at 1280,
390 and 320 CSS pixels, locale matching and persistence. Pass a third
argument to save screenshots of the 390px Traditional Chinese, Japanese,
German and Brazilian Portuguese menus. At every width it also checks the menu's
size, corners and tick, and that no Korean or Japanese heading or tagline
breaks a line inside a word. It checks that the buttons fetch this
version's Mac, Windows and Windows ARM64 installers, and that a Windows
visitor gets the Windows installer first. The Showcase routing tests cover
every localized URL, assets, metadata and the sitemap.

## Markdown title acceptance

`acceptance/markdown-title.json` records a local built-page browser check in
English and Chinese at 1280px and 390px viewport widths. A DOM Range around
the title is compared with its clipping container: the original 11px line
clips the 13px text bounds by 1px above and below; the 16px line contains them.
The same observations retain the title bar height and horizontal ellipsis,
and confirm that all three cover masks still render after the build.
