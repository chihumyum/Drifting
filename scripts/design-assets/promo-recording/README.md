# Promo recording

A promo video of the real app at work: a script plays the author. Drifting
opens from the Dock on its shelf; the author creates a new book, gives it a
first chapter and writes a short story into it in immersive writing with real
keystrokes, stopping once to ask the Agent to look up a passage of a classic
on the web; then asks the Agent to organize the chapter into elements and to
review it. The take is recorded from the app's own window and composed
afterwards into a finished video with a steady camera: it frames each thing
that happens and holds there, the paper while the author writes, the dialog
or the composer while something is typed into it, the Agent's panel while it
works, and moves only when the next action would leave the frame.

```bash
pnpm promo:record --story <story.md> --take <name>   # takes the screen for several minutes
pnpm promo:compose --take <name>                      # out/promo-recording/<name>/promo.mp4
pnpm promo:compose --take <name> --size 2160 --pace 1.5   # 4K, played half as fast again: promo-2160-1.5x.mp4
```

Without `--story` the recording types `sample-story.zh-CN.md`, a short
synthetic story for checking the pipeline. Stories that are not meant for the
repository (an author's own text) belong in the ignored `out/` folder, for
example `out/promo-recording/stories/`.

## Requirements

- macOS with the terminal (or app) that runs the scripts allowed **Screen
  Recording** and **Accessibility** in System Settings › Privacy & Security.
- The Agent uses OpenAI with the API key from the checkout's `.env.local`, like
  every development profile (`docs/worktree-development.md`, "Agent keys in
  development"): its hosted web search is what looks the passage up
  (`docs/agent-runtime/provider-extension-protocol.md`). `--provider` and
  `--model` pick another (default `openai`, `gpt-5.6-sol`); DeepSeek has no web
  search, so a story with an `ask` needs OpenAI.
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
ask: 下一场写有人来瓜摊找茬。名著里有类似的场面吗？上网找一段原文，摘三四句，附上出处。
links: 刘华强, 素娟
memory: 第一人称叙述者是郝哥。整理人物要素时，别名不要用「我」「她」这类代词。
---

吸铁石。

<!-- quick -->
我的脑子当场死了机。…

<!-- ask -->
# 保熟吗

<!-- slow -->
<!-- typo 块→快 -->
“两块钱一斤。”
…
```

- `book` and `chapter` are what the author names the new book (in the shelf's
  new-book dialog) and its first chapter (made from Project Home); the shelf
  around it is the release screenshot shelf (`docs/release-screenshots.md`).
- `organize` is what the author types to the Agent once the chapter is written.
- `ask` (optional) is what the author asks the Agent before the paragraph marked
  `<!-- ask -->`: out of immersive writing, in the Agent's panel; the camera
  reads the answer from its top, then the author goes back to the chapter.
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
  normal and narration fast. The opening line is always slow and close.
- `<!-- quick -->` before a paragraph types it at 45 characters a second, to
  keep a take short; the video plays it back at a steady 8 a second, so it
  still reads as writing. Nothing is cut: every paragraph is typed on camera.

## How a take is recorded

`record.ts` seeds the isolated `promo-recording` profile with the screenshot
shelf (`src/dev-cli/showcase-seed-main.ts`), launches its Debug build with the
frontend debug bridge and sets the interface to Chinese, the theme and the
Agent model. Before recording it opens, off camera, in a book of the shelf,
everything the take will open on camera (`scenes.js` `warmupBook`): the
development server optimizes a dependency on first use and reloads the page,
which must not happen mid-take.

The take then runs as the author would: the pointer parked where Drifting's
icon will be in the opening's Dock (below the window), the shelf's new-book
card, the name typed into the dialog, 新建, Project Home's 新建 · 章节, the
chapter's title, Return into the page, `⌘⇧↩` into immersive writing (its
typewriter scrolling keeps the caret's line in the middle of the window), the
story, `⌘⇧↩` out for the Agent. Typing is recorded at the pace the video plays
it: about 3.4 characters a second for slow lines, 5.6 for dialogue and 8.2 for
narration, with pauses after punctuation.

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
  recording it shows: everything at its own pace except each Agent wait,
  squeezed into about 4.5 seconds with a badge showing how much
  (`--no-badge` drops it), and quick paragraphs, slowed to a steady 8
  characters a second. `--pace <x>` plays all of it `x` times faster once the
  window has opened (quick paragraphs at 8·x a second, Agent waits in 4.5/x
  seconds); the opening, the end card and the sounds keep their own pace, and
  the camera's moves, timed in output seconds, stay as smooth.
- The camera holds still. A framing is chosen when something new starts — a
  `shot` mark, the start of immersive writing (the paper's column, about 2×,
  the caret's line just under the middle), a prompt or a field being typed
  (the box it is typed in) — and kept while the action stays inside it: a
  click inside the frame's safe area, or a caret within its middle band, moves
  nothing; one outside moves the camera once, a little further than needed.
  The moves are a critically damped spring in output time (zoom in log space),
  a third of a second ahead of what happens; once zoomed in it stays on the
  window.
- The opening is drawn: a desktop of the backdrop with a Dock holding only
  Drifting's icon (`src/assets/icon.png`), the pointer coming to it, a click,
  one launch bounce, and the recorded window growing in from it before the
  Dock hides. A real Dock would show the recording machine's own apps, and a
  development build's Dock name is not the product's.
- After the last shot a closing card fades in (`--no-end-card` drops it): the
  icon, the name, the README's one-line description and the address.
- The pointer is drawn from the rig's samples, hidden from a keystroke until
  the next move as macOS does, with a ripple at each click.
- `compose.swift` renders the frames with Core Image: the window scaled from its
  Retina pixels with a Lanczos filter on a quiet backdrop with a soft shadow,
  the opening's Dock, then the pointer, ripples and badge, and the closing card,
  into a high-bitrate intermediate
  (`video-<size>.mov`); `ffmpeg` encodes the final `promo.mp4` with x264 at CRF
  18, about 40 MB for two minutes at 1080p.
- `sound.ts` synthesizes a soft click for every keystroke and pointer click at
  its output time from shaped noise (no recordings, no pitched tones);
  `--music <file>` mixes a track under it, faded out at the end.

`--size 1440` or `2160` renders larger (`promo-<size>.mp4`); 4K is what to
upload, since a platform re-encodes whatever it gets. The recording has two
pixels per point, so 4K's wide shots are sharper than 1080p's and its closest
shots are scaled up a little. The intermediate is 40, 80 or 160 Mbit/s by size
and 4K is encoded at x264's `medium` preset; still paper makes the final a few
Mbit/s at CRF 18 without softening the text.

## Known behaviour

- While the Agent works, ScreenCaptureKit has been seen to capture something
  57 points taller than the window (the window's own size and the page's do not
  change) and shrink it all by 0.946 to fit the frame, the window at its
  top-left. The rig logs every change of the frames' content scale and origin
  (`frames.content` in `events.jsonl`) and `compose.swift` scales those frames
  back, so the video never shows it.
- The Agent is the real model, so every take differs; record a few and keep the
  best.
