# Promo video

A 32-second video for sharing Drifting (X, YouTube, Bilibili, the site), in
English and in Chinese, 1920×1080 at 60 fps, silent.

```sh
node scripts/design-assets/promo-video/render.mjs                    # both languages → out/promo-video/
node scripts/design-assets/promo-video/render.mjs --lang zh --fps 30 # one language, a quicker draft
node scripts/design-assets/promo-video/render.mjs --stills 3.8,15    # PNGs at those seconds (covers, review)
```

It writes `drifting-promo-en.mp4` and `drifting-promo-zh.mp4` (H.264, BT.709,
`+faststart`), about 3 minutes a language at 60 fps. It needs `pnpm install`,
Google Chrome (`CHROME` overrides the path; WebGL2 runs on Metal in headless
mode), Times New Roman from the system and `ffmpeg` with libx264.

`node scripts/design-assets/promo-video/build.mjs [dir]` writes the page alone
(`out/promo-video/page`). Served from that directory, `index.html?lang=zh`
plays it in a browser in real time and `&t=14` starts it at a second.

What is in it, second by second:

| From | What |
| --- | --- |
| 0 | Rain on the character sea (it has fallen for 2.4 seconds before the first frame, so a feed's still shows it); a stone drops. |
| 0.75 | DRIFTING rises out of the sea as on the landing page; the tagline comes in under it and its three words are underlined in their pillars' colours. |
| 5.25 | The word is let go and bursts as one ring from its outline. |
| 5.85 | Write: a sheet of glass unfolds; Markdown takes shape as it is typed while the `.md` file beside it is saved. |
| 13.25 | Build: the sheet takes the next pillar's size; the sidebar's tabs push their panels, a click opens a page and the dry frame goes round the cell. |
| 20.05 | Tend: the ask, the Agent's steps one by one, its edit erased and written into the page, marked. |
| 27.45 | The sheet folds away and DRIFTING rises again over drifting.cc and the facts under the landing page's buttons. |

How it is made, and why:

- **One clock** (`clock.js`, loaded first). Time on the page stands still until
  `step(t)` moves it: `performance.now`, `Date.now`, timers and animation
  frames read the video's clock, `Math.random` is seeded, and every CSS
  animation and transition is paused and set to the clock's time. A frame is
  the same picture however long its capture takes, and a rerun gives the same
  video. Frames must come in order: the sea is a simulation stepped once a
  frame.
- **The sea** is the app's own `lib/char-sea`, raising DRIFTING as the
  landing page does. Times New Roman Bold's hairlines are thinner than one of
  the app's cells, so at 1080p the capitals read only on a denser sheet (1.75
  times; the sharing card uses 1.9) with heavier risen characters (`wordInk`
  2.2); at 1.75 a raindrop still shows. The canvas is lifted to 1.3 brightness
  so the sea carries on a phone.
- **The corners** are the landing page's: `build.mjs` takes `#vg-md`,
  `#vg-studio` and `#vg-agent` and the page's `<style>` from
  `landing/index.html`, and `site.css` from `landing/`, so the video shows
  what drifting.cc shows. Their scripts are not taken: `video.mjs` plays each
  corner as a function of the scene's time instead of on timers, with the
  same texts, steps and timings scaled to the scene.
- **The pillars lie on one sheet of glass** the sea draws (its resting line and
  12% veil). It unfolds from its middle under the first pillar and morphs to
  each next pillar's size as the words change, so a cut never shows an empty
  frame.
- **Copy** is the landing page's and the README's, in both languages; the
  Chinese headings break where a phrase ends. The page lays out at 1152×648 CSS
  px and is captured at device scale 1920/1152, so the corners' 15px text is
  25px in the video.
