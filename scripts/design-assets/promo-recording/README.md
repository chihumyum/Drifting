# Promo recording

A promo video of the real app at work: a script plays the author, typing a
short story into an empty chapter with real keystrokes, then asks the Agent to
organize the chapter into elements and to review it. The take is recorded from
the app's own window and composed afterwards into a finished video whose camera
follows what happens: close on the caret while the author types, out to the
whole window at the reveal, onto the Agent's panel while it works, onto the
names it linked, the element overview and the comments it left.

```bash
pnpm promo:record --story <story.md> --take <name>   # takes the screen for several minutes
pnpm promo:compose --take <name>                      # out/promo-recording/<name>/promo.mp4
```

Without `--story` the recording types `sample-story.zh-CN.md`, a short
synthetic story for checking the pipeline. Stories that are not meant for the
repository (an author's own text) belong in the ignored `out/` folder, for
example `out/promo-recording/stories/`.

## Requirements

- macOS with the terminal (or app) that runs the scripts allowed **Screen
  Recording** and **Accessibility** in System Settings › Privacy & Security.
- The Agent uses DeepSeek, keyed from the checkout's `.env.local` like every
  development profile (`docs/worktree-development.md`, "Agent keys in
  development"). `--model` picks the model (default `deepseek-v4-pro`).
- `ffmpeg` on the `PATH` for the final mux.

While `promo:record` runs, leave the keyboard and pointer alone: the window must
stay in front (WebKit draws nothing in a covered window), and the rig switches
the keyboard to the ABC layout so an input method cannot take the keystrokes;
it restores the previous one when it finishes.

## The story file

```markdown
---
book: 华强买瓜
chapter: 瓜摊
organize: 把这一章出现的人物、地点和物件整理成要素，再连上它们之间的关系。
links: 刘华强, 素娟
memory: 第一人称叙述者是郝哥。整理人物要素时，别名不要用「我」「她」这类代词。
---

吸铁石。

<!-- slow -->
<!-- typo 块→快 -->
“两块钱一斤。”

# 十分钟前
…
```

- `book` and `chapter` name the new book and its one empty chapter; the shelf
  around it is the release screenshot shelf (`docs/release-screenshots.md`).
- `organize` is what the author types to the Agent once the chapter is written.
- `links` are the names to point at once the Agent has made them elements; the
  first visible one is hovered so its card opens.
- `memory` (optional) is Project Memory the book starts with, as if the author
  had told the Agent before.
- Paragraphs are separated by blank lines and typed exactly as written, so
  `# `, `## `, `### ` become a scene, beat or note heading and `**…**` bold as
  they would for the author.
- A comment line before a paragraph sets its pace (`<!-- slow -->`,
  `<!-- normal -->`, `<!-- fast -->`) or a typo the writer corrects
  (`<!-- typo 块→快 -->` types 快 where the first 块 is, pauses, deletes it and
  goes on). Without one, headings are slow, dialogue (opening with a quote mark)
  normal and narration fast.

## How a take is recorded

`record.ts` seeds the isolated `promo-recording` profile (the screenshot shelf
plus the new book, via `src/dev-cli/showcase-seed-main.ts --open-book`),
launches its Debug build with the frontend debug bridge and sets the interface
to Chinese, the theme and the Agent model. Before recording it opens, off
camera, everything the take will open on camera (`scenes.js` `warmup`): the
development server optimizes a dependency on first use and reloads the page,
which must not happen mid-take.

`rig.swift` (compiled into `out/promo-recording/bin/`) is one process that
records the window with ScreenCaptureKit at its Retina pixels, without the
system pointer, and drives the real pointer and keyboard with system events.
Every frame and every input it posts is stamped on the host clock; `record.ts`
measures that clock against Node's and stamps its own marks (where the caret
is while typing, what the camera should look at, when the Agent starts and
ends) on it too. The scenes script only answers geometry and state questions
(`caret`, `rect`, `links`, `cards`, `agent`); everything on camera is real
input.

The take is written to `out/promo-recording/<take>/`: `raw.mov` (HEVC with
alpha), `events.jsonl` (the rig's), `marks.jsonl` (the script's) and
`timeline.json` (both, relative to the first frame).

## How a take becomes a video

`compose.ts` plans and renders it:

- `plan.ts` decides, for each output frame at 60 fps, which instant of the
  recording it shows: narration typing runs 4× and dialogue 2× faster than it
  was typed, headings and lines marked slow at their own pace, and each Agent
  wait is squeezed into about 4.5 seconds; speeds ease into each other. A
  badge shows how much each Agent wait was sped up (`--no-badge` drops it);
  typing needs none, it is plainly fast.
- The camera follows marks: while typing, the text column at the caret's line
  (a little below the middle, about 1.8× close, the opening line closer);
  otherwise the last `shot` or `target` mark (every click is one). It is
  a critically damped spring in output time (zoom in log space), moving a third
  of a second ahead of what happens, and it stays on the window once zoomed in.
- The pointer is drawn from the rig's samples, hidden from a keystroke until
  the next move as macOS does, with a ripple at each click.
- `compose.swift` renders the frames with Core Image: the window scaled from its
  Retina pixels with a Lanczos filter on a quiet backdrop with a soft shadow,
  then the pointer, ripples and badge, into H.264.
- `sound.ts` synthesizes a soft click for every keystroke and pointer click at
  its output time from shaped noise (no recordings, no pitched tones);
  `--music <file>` mixes a track under it, faded out at the end.

`--size 1440` or `2160` renders larger; at 1080 the closest shots are still
about one recorded pixel per output pixel.

## Known behaviour

- While the Agent works, ScreenCaptureKit has been seen to capture something
  57 points taller than the window (the window's own size and the page's do not
  change) and shrink it all by 0.946 to fit the frame, the window at its
  top-left. The rig logs every change of the frames' content scale and origin
  (`frames.content` in `events.jsonl`) and `compose.swift` scales those frames
  back, so the video never shows it.
- The Agent is the real model, so every take differs; record a few and keep the
  best.
