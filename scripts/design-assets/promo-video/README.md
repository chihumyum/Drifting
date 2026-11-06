# Promo video

A 32-second video for sharing Drifting (X, YouTube, Bilibili, the site), in
English and in Chinese, 1920×1080 at 60 fps, silent and with its own sound.

```sh
node scripts/design-assets/promo-video/render.mjs                    # both languages → out/promo-video/
node scripts/design-assets/promo-video/render.mjs --lang zh --fps 30 # one language, a quicker draft
node scripts/design-assets/promo-video/render.mjs --stills 4.4,15    # PNGs at those seconds (covers, review)
node scripts/design-assets/promo-video/render.mjs --stills 4.4 --aspect 4:3 --lang zh  # the 4:3 cover, 1920×1440
node scripts/design-assets/promo-video/render.mjs --stills 4.4 --tagline 1.5 --lang zh  # a 16:9 cover, its tagline larger
node scripts/design-assets/promo-video/render.mjs --sound-only       # new sound on the videos already rendered
node scripts/design-assets/promo-video/render.mjs --bookends --lang zh --theme light --size 2160
```

The cover is the opening's still at 4.4 seconds: DRIFTING over its tagline.
`--aspect 4:3` (stills only; `still-<lang>-<second>-4x3.png`) lays the page
out 1152×864 for a feed's 4:3 cover. There the tagline is one phrase a line (a
break after each comma), its widest line as wide as DRIFTING, and the two are
centred together in the frame. `--tagline 1.5` (stills at 16:9 only;
`still-<lang>-<second>-tagline1.5.png`) sets the tagline 1.5 times its size on
its own two lines, the two again centred together; the author's 16:9 cover
uses 1.5. Without these the frames are the video's, byte for byte.

`--bookends` renders only the opening (the rain, DRIFTING rising with the
tagline, its burst) and the closing (DRIFTING again over drifting.cc and the
facts), each as its own clip with the rain and stones under it and no score:
`drifting-bookend-{open,close}-<lang>-<theme>[-2160].mp4`. They open and close
a recorded demo (`../promo-recording`, `promo:compose --bookends`). `--theme
light` draws the sea and the words in the light interface's colours, as the
landing page's light theme does; `--size 2160` captures at 3840×2160.

For each language it writes:

| File | What |
| --- | --- |
| `drifting-promo-<lang>.mp4` | The picture, silent (H.264, BT.709, `+faststart`). |
| `drifting-promo-<lang>-sound.mp4` | The same picture stream with the sound (AAC 192k). |
| `drifting-promo-<lang>.wav` | The sound: the score, rain and effects, −16 LUFS. |
| `drifting-promo-<lang>-effects.wav` | Rain and effects without the score, −16 LUFS, for laying other music under it. |
| `drifting-promo-<lang>-cues.json` | The sections and when each effect falls (keys left out), for cutting other music to the picture. |

And from the English video, `drifting-promo-en-readme.mp4` (720p, 30 fps, about
7.5 MB) for the top of the repository's README. GitHub plays a video in a
README only as an attachment uploaded through its web editor (at most 10 MB
on a free account): drag the file into a new issue's text box on
github.com/chihumyum/Drifting, copy the `user-attachments` URL it writes, and
put that URL on its own line under the README's tagline. An attachment may
answer 404 to visitors who are not signed in until saved content uses it, so
check the README in a private window once it is pushed.

About 3 minutes a language at 60 fps; `--sound-only` takes seconds. It needs
`pnpm install`, Google Chrome (`CHROME` overrides the path; WebGL2 runs on
Metal in headless mode), Times New Roman from the system and `ffmpeg` with
libx264.

`node scripts/design-assets/promo-video/build.mjs [dir] [--lang en|zh]` writes the page alone
(its corners in the landing page's copy for that language)
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
- **The sound** (`sound.mjs`, `instruments.mjs`, `sampler.swift`) is made
  from the page's own list of what happens when (`window.__promo.sounds`),
  built from the same schedules the picture plays.
  - **The score** is a short piece in D minor whose turns sit on the video's
    `section` marks: one high A as the stone drops; a falling line as the
    name rises, held on B flat through the burst; with each sheet's stones a
    hit — the piano's low octave, the strings bowed hard and, on the sampled
    orchestra, French horns, trombones and tuba struck together (on the
    modelled one a timpano) — on D, then G, then B flat, rising with each
    sheet and harder each time, while each stone rings a high piano note of
    the chord, heard where it falls; broken chords under the pillars (Dm Bb F
    C, then Gm Dm Bb A) with a clarinet's low counter-line over a plucked
    double bass in the first, horns coming in and the bass pulsing toward the
    hit in the second; under the Agent a lament bass (B flat, A, G, A, D),
    horns holding the climax and a flute answering the piano's high A, all
    resolving to D minor as the edit settles (the `settle` cue, so each
    language lands on its own frame); the high A again on flute and piano
    over D minor with an added ninth at the close, and the clarinet's sigh.
  - **Rise and fall**: each chord's notes lean late as it ends (a ritardando;
    the change keeps its frame), the melody sings a hair after the hand
    under it, each two-chord phrase swells and falls away, every held note
    and chord swells to its middle, twice the hand leaves out a note to
    breathe, and the piece is quiet at the opening, climbs through the second
    pillar into the Agent and is quieter still at the close.
  - **The instruments.** With GarageBand's sound library installed
    (GarageBand → Sound Library → Download All Available Sounds; it lands in
    `/Library/Application Support/Logic`), `instruments.mjs` plays the score
    on it: the Steinway Grand Piano read straight from its EXS zones and
    consolidated CAF (four velocity layers by register, the instrument's own
    −7 cent tune, dampers lifting at each pedal change) because the system's
    sampler cannot open consolidated samples, and String Ensemble, French
    Horns, Clarinet and Flute Solo, Upright Jazz Bass and the staccato horns,
    trombones and tuba through `sampler.swift`, which plays a note list on
    AVAudioUnitSampler offline. Each part is brought to its level (dBFS RMS
    while it plays) after the score's dynamics are applied. Apple's licence
    lets these sounds be used in one's own soundtracks; nothing of them
    enters the repository. Without the library, or with `--modelled`, the
    score is played on `sound.mjs`'s modelled felt piano (inharmonic
    partials, detuned strings, a quick and a slow decay, the felt darker
    under a soft touch), dark bowed strings and a modelled timpano.
  - **The effects** are all shaped noise, never a tone: rain all the way
    through (6 dB softer under the sheets), air as the name rises and as it
    bursts over a low rumble, a key for each character, the brush as each
    frame and underline is drawn and reversed for the Agent's erase, air for
    a tab's push, a sent message and the glass sheet, and soft taps for a
    saved line and each Agent step. Each is heard where its element sits
    across the frame. The author turned down pitched bloops and glass chimes
    and asked for real instruments in the score: keep effects toneless and
    music acoustic.
  - **The mix**: the score below 40 Hz cut, 3 dB lighter below 140 Hz, and
    only what is above 220 Hz sent into its hall (Freeverb), so the low end
    stays clear. Nothing is clipped while mixing (the WAV is float). It is
    brought to −16 LUFS by one fixed gain, the few peaks it would lift past
    −2 dBFS held first by a look-ahead limiter (10 ms, its delay compensated
    so the sound stays on its frame) so the rain never pumps, the loudness
    measured again after the limiter and corrected; a rerun gives the same
    samples. The hits are written to need almost none of it — at most about
    1.6 dB: the players land 8–24 ms apart (piano, horns, trombones, tuba),
    the lowest octave is lighter, the hit brass keeps out of the piece's
    swell and off its loudest layer, and its short strokes are levelled by
    peak, not RMS, so one hit played softer does not lift the others. The
    author heard the first orchestral hits as distortion: the third had been
    limited by 6 dB.
- **Copy** is the landing page's and the README's, in both languages; the
  Chinese headings break where a phrase ends. The page lays out at 1152×648 CSS
  px and is captured at device scale 1920/1152, so the corners' 15px text is
  25px in the video.
