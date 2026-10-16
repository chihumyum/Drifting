# IME text lookup through hidden editor tabs

## Symptom and evidence

On 2026-10-17 the author reported that Chinese typing in the desktop app felt
sluggish again. The [dev stall watchdog](dev-stall-watchdog.md) logged nothing
because each delay was well under a second. A 6 s native sample of the WebContent
process, taken while the author typed near the end of a 4,851-character chapter,
put 22% of main-thread samples in
`WebPage::attributedSubstringForCharacterRangeAsync`. That is the macOS input
method asking for the text around the caret. Most of the cost was
`EditingRange::toRange` → `resolveCharacterRange`. It built a `VisiblePosition`
and called `next()`, which advanced one character at a time (`Position::next`,
`RenderText::nextOffset`) and created a character-cluster break iterator at each
step. In the same sample, the app's JavaScript (ProseMirror, Yjs, React) took
about 2%.

## Cause

If a requested range ends on the editable root's final newline or on a replaced
element, WebKit's `resolveCharacterRange` finds the range's end by calling
`VisiblePosition(start).next()`. That walk is not limited to the editable root.
It keeps going through the document until it finds a caret candidate. Text that
is laid out but has `visibility: hidden` or `user-select: none` is not a candidate,
so WebKit steps through it one character at a time. Text without a renderer
(`display: none`) is skipped one node at a time.

`EditorMainArea` keeps every open top-level tab mounted as an absolute surface
with `visibility: hidden` (see
[desktop editor-session continuity](../renderer-ui-architecture.md#desktop-editor-session-continuity)).
A temporary survey of the author's live DOM counted 38,813 non-candidate
characters between the active editor's end and the first candidate (in the right
sidebar). Almost all of them were in hidden chapter editors. Each lookup near a
chapter's end therefore walked the prose of every tab after the active one, and
the input method makes several lookups per keystroke. The cost grew as the author
opened more chapters. Adding `content-visibility: hidden` or `user-select: none`
to the hidden surfaces does not shorten the walk.

## Fix

`TextInputLookupStop` ends every desktop editor surface with one zero-width
character. It is selectable, absolutely positioned at 0×0, ignores pointer
events and is `aria-hidden`. It inherits the surface's visibility. In the visible
surface it is the first caret candidate after the editor's content, so the walk
stops there. In a hidden surface it is not a candidate and has no effect.
Hiding inactive surfaces with `display: none` also ends the walk, but it would
break the continuity contract for retained layout and scroll positions.

`text-input-lookup-stop.test.ts` checks the stop's markup. It also checks that the
stop does not override visibility and that it follows the content of every surface.

## Measurements

`scripts/measure-webkit-ime-lookup.swift` (instructions in the file) loads
synthetic markup that mirrors the stage into a `WKWebView`: an active surface
whose editor ends with empty paragraphs, followed by a hidden surface. It calls
the input method's entry point `attributedSubstringForProposedRange:completionHandler:`
for every range of length 0–4 that starts within four characters of the caret at
the editor's end, and reports the slowest median. Measured on macOS 27 (Apple silicon):

| Case | Hidden characters | Slowest median |
| --- | ---: | ---: |
| No hidden surfaces | 0 | 0.17 ms |
| Hidden surfaces, no stop | 38,400 | 12.6 ms |
| Hidden surfaces, with stop | 38,400 | 0.17 ms |
| 4× hidden surfaces, no stop | 153,600 | 50.1 ms |
| 4× hidden surfaces, with stop | 153,600 | 0.16 ms |

In the author's dev app, with the same tabs open and the author typing at the
same chapter's end, an 8 s sample after the fix put 0.4% of main-thread samples in
the lookup, down from 22%. Range resolution no longer appears in it.

## Boundaries

- The walk still crosses any non-candidate content inside the active surface
  that comes after the editor. In the 通览全书 read-through, the chapter row after
  the live chapter is normally rendered and stops the walk. Offscreen
  `content-visibility: auto` rows were not measured.
- Mobile shells do not use `EditorMainArea` and are not covered.
- To diagnose this kind of jank, sample the WebContent process while the author
  types (`webContentPid` in `renderer-stalls.log`), then look for
  `AttributedSubstringForCharacterRangeAsync`.
