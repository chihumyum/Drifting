# Promo video

A 32-second video for sharing Drifting (X, YouTube, Bilibili, the site), in
English and in Chinese, 1920×1080 at 60 fps, silent and with its own sound.

```sh
node scripts/design-assets/promo-video/render.mjs                    # both languages → out/promo-video/
node scripts/design-assets/promo-video/render.mjs --lang zh --fps 30 # one language, a quicker draft
node scripts/design-assets/promo-video/render.mjs --stills 4.4,15    # PNGs at those seconds (covers, review)
node scripts/design-assets/promo-video/render.mjs --sound-only       # new sound on the videos already rendered
```

For each language it writes:

| File | What |
| --- | --- |
| `drifting-promo-<lang>.mp4` | The picture, silent (H.264, BT.709, `+faststart`). |
| `drifting-promo-<lang>-sound.mp4` | The same picture stream with the sound (AAC 192k). |
| `drifting-promo-<lang>.wav` | The sound: the score, rain and effects, −16 LUFS. |
| `drifting-promo-<lang>-effects.wav` | Rain and effects without the score, −16 LUFS, for laying other music under it. |
| `drifting-promo-<lang>-cues.json` | The sections and when each effect falls (keys left out), for cutting other music to the picture. |

About 3 minutes a language at 60 fps; `--sound-only` takes seconds. It needs
`pnpm install`, Google Chrome (`CHROME` overrides the path; WebGL2 runs on
Metal in headless mode), Times New Roman from the system and `ffmpeg` with
libx264.

`node scripts/design-assets/promo-video/build.mjs [dir]` writes the page alone
(`out/promo-video/page`). Served from that directory, `index.html?lang=zh`
plays it in a browser in real time and `&t=14` starts it at a second.

What is in it, second by second:

| From | What |
| --- | --- |
| 0 | Rain on the character sea (it has fallen for 2.4 seconds before the first frame, so a feed's still shows it); a stone drops. |
| 0.75 | DRIFTING rises out of the sea as on the landing page; the tagline comes in under it and its three words are underlined in their pillars' colours. |
| 5.25 | The word is let go and bursts as one ring from its outline. |
| 5.7 | Two stones fall on the sea, with the first hit (on D). |
| 6.1 | Write: a sheet of glass unfolds over their rings; Markdown takes shape as it is typed while the `.md` file beside it is saved. |
| 13.4 | The sheet folds away; three stones fall, with the second hit (on G). |
| 13.8 | Build: the next sheet unfolds; the sidebar's tabs push their panels, a click opens a page and the dry frame goes round the cell. |
| 20.5 | The sheet folds away; four stones fall, with the third hit (on B flat). |
| 20.9 | Tend: the ask, the Agent's steps one by one, its edit erased and written into the page, marked. |
| 28.1 | The sheet folds away and DRIFTING rises again over drifting.cc and the facts under the landing page's buttons. |

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
- **Each pillar lies on a sheet of glass** the sea draws (its resting line and
  12% veil). Before each sheet, stones fall on the open sea — one more each
  time than the opening's single stone (two, three, four), scattered from a
  fixed seed so no two land close, 55 ms apart — and the sheet unfolds from
  its middle over their rings. It folds back to its middle as its words fade,
  so the next stones fall on open water: under the glass the sea shows at
  only 12% and their rings would not be seen. With the glass gone there is
  water to look at, never an empty frame.
- **The sound** (`sound.mjs`) is synthesized, not recorded, so nothing in it
  needs a licence, and it is made from the page's own list of what happens
  when (`window.__promo.sounds`), built from the same schedules the picture
  plays.
  - **The score** is a short piece in D minor for a modelled felt piano
    (inharmonic partials, two or three detuned strings a note, a quick and a
    slow decay, the felt darker under a soft touch, the hammer's knock, a pedal
    lifted at each chord change) over low bowed strings kept 7–9 dB under it.
    Its turns sit on the video's `section` marks: one high A as the stone
    drops; a falling line as the name rises, held on B flat through the
    burst; with each sheet's stones a hit — a modelled timpano (a felt
    mallet ringing the head's inharmonic modes, its pitch sagging just after
    the stroke), the piano's low octave and the strings bowed hard — on D,
    then G, then B flat, rising with each sheet and harder each time, while
    each stone rings a high piano note of the chord, heard where it falls;
    broken chords under the pillars (Dm Bb F C, then Gm Dm Bb A); the line
    reaching its high A under the Agent and resolving to D minor as its edit
    settles (the `settle` cue, so each language lands on its own frame); the
    high A again over D minor with an added ninth at the close.
  - **The effects** are all shaped noise, never a tone: rain all the way
    through (6 dB softer under the sheets), air as the name rises and as it
    bursts over a low rumble, a key for each character, the brush as each
    frame and underline is drawn and reversed for the Agent's erase, air for
    a tab's push, a sent message and the glass sheet, and soft taps for a
    saved line and each Agent step. Each is heard where its element sits
    across the frame. The author turned down the earlier pitched drop and
    send bloops and glass chimes: keep effects toneless.
  - **The mix**: the score below 40 Hz cut, 3 dB lighter below 140 Hz, and
    only what is above 220 Hz sent into its hall (Freeverb), so the low end
    stays clear. Nothing is clipped while mixing (the WAV is float), so the
    hits keep their attack. It is brought to −16 LUFS by one fixed gain, the few peaks
    it would lift past −2 dBFS held first by a look-ahead limiter, so the
    rain never pumps; a rerun gives the same samples.
- **Copy** is the landing page's and the README's, in both languages; the
  Chinese headings break where a phrase ends. The page lays out at 1152×648 CSS
  px and is captured at device scale 1920/1152, so the corners' 15px text is
  25px in the video.
