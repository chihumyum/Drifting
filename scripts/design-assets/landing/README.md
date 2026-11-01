# Landing page

drifting.cc's home page and the look the whole site shares, built as a static
directory that the site repository (Drifting-Showcase) serves beside its
`/privacy`, `/terms` and `/support` pages and its 404.

```sh
node scripts/design-assets/landing/build.mjs                       # writes out/landing/
node scripts/design-assets/landing/build.mjs ../site --og card.png # another directory, with the sharing card
```

It writes the home page in English (`index.html`, served at `/`) and in Chinese
(`zh.html`, served at `/zh`), `assets/` and `fonts/` (and `og.png` with `--og`;
use `social-preview/`'s `dark.png`), and leaves everything else in the
directory alone. Every page links `/legal/favicon-32x32.png` and
`/legal/apple-touch-icon.png`, which the site serves; `app-icon/render.sh`
renders both from the app icon.

What is shared, and where it comes from:

- `site.css` → `/assets/site.css`: the app's tokens, glass, sand marks, the bar,
  the sheets, the footer, the font faces, and the information pages' heading and
  prose. The home page's own layout stays inline in `index.html`.
- `prefs.js` → `/assets/prefs.js`, in each page's head: the language (a `#zh` or
  `#en` link, the visitor's last choice, then the browser's) and a theme picked
  in this tab, applied before the page paints. Without a pick the theme follows
  the system on every visit; a pick lasts only for the tab (sessionStorage). On
  the home page the language picks the page: `/` opens `/zh` for a visitor who
  reads Chinese or follows a `#zh` link, `/zh#en` opens `/#en`, and `/zh` never
  sends a reader away unasked. The information pages show the language picked.
- `site.mjs`: the language and theme buttons, the sheets whose glass the sea
  draws, and the pointer's ripples. On the home page the language button is a
  link to the other page (following it keeps the choice); on the information
  pages it switches the page in place, and the bar's name leads to `/` or `/zh`
  by the language shown. `entry.mjs` (→ `/assets/landing.js`) and `pages.mjs`
  (→ `/assets/pages.js`, the information pages' script) both bundle it.

What is on the page, and why:

- **The sea.** `entry.mjs` bundles the app's own `lib/char-sea`, `sand-frame`
  and `sand-cover` with esbuild. The page passes `CharSeaOptions`: it raises
  DRIFTING instead of "Loading", at 0.4 of the window's height so the tagline
  and buttons fit under it, with heavier characters in the word (`wordInk`) and
  a denser sheet on narrow windows. `charSeaWordBox` places the tagline under
  the word. The rain falls the whole way down (`rain(true)`, as on the app's
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
  down the cover. As on the app's shelf, the cover carries its genre at the
  foot and no title initial in the upper corner (2026-11-02).
- **The name in the bar** is written in sand, like the sharing card's
  tagline: `wordmark.sh` renders `wordmark.html` (each letter of DRIFTING
  traced and laid with `social-preview/sand-letters.js`) to
  `src/assets/design/sand/wordmark-drifting.png`, and `site.css` shows it as a
  mask in ink inside the bar's pill. The link keeps the word as text for
  readers and search engines.
- **Copy** comes from the README in both languages. `index.html` says
  everything twice, each piece marked `data-l="zh"` or `data-l="en"` (the head's
  title, description, canonical and sharing tags too); `build.mjs` writes each
  language's page with only its own pieces, unmarked, so a search engine reads
  one language at one address, and the sea writes in that page's script. A link
  from a home page to an information page carries the page's `#zh` or `#en`.
  Theme follows the system, or the round button.
- **Nothing from another host.** Fonts are the app's own `@fontsource-variable`
  faces, copied as only the slices holding a character a page (this one, and
  the information pages already in the directory) or the sea writes, under the app's family names so the sea's font stacks find them. The
  site's privacy policy says it loads no third-party resources; keep it true.
- **For search engines and sharing.** Each page's head names its address
  (`canonical`, `og:url`: `https://drifting.cc/` or `https://drifting.cc/zh`,
  on the host the app, README and policies link to) and both languages'
  (`hreflang` `en`, `zh` and `x-default` → `/`), a title that says what Drifting
  is, its locale, the sharing card (`/og.png`, with its size and alt text) and,
  as JSON-LD, the site's name and languages and the app as a free, open-source
  macOS download. The page's outline is the
  word (`h1`) and one `h2` per sheet: the corners' page titles, the headings
  typed in the Markdown corner and the book's title are styled elements, not
  headings. `robots.txt` and `sitemap.xml` belong to the site repository; a new
  page there goes into the sitemap too.

## Markdown title acceptance

`acceptance/markdown-title.json` records a local built-page browser check in
English and Chinese at 1280px and 390px viewport widths. A DOM Range around
the title is compared with its clipping container: the original 11px line
clips the 13px text bounds by 1px above and below; the 16px line contains them.
The same observations retain the title bar height and horizontal ellipsis,
and confirm that all three cover masks still render after the build.
