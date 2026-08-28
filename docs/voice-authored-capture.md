# Voice-authored writing

Status: **TODO — not implemented**

Updated: 2026-08-28

## Idea

Let authors speak their ideas into Drifting without first deciding where those
ideas belong.

Drifting should understand the capture, find the relevant context, lightly
organize it, and place it into the right chapter, character, setting,
storyline, Inspiration, or TODO.

> 你只管把故事说出来，不必先想清楚它该放在哪里。Drifting 会理解、找到上下文，
> 并安全地让它成为小说的一部分。

This could become a major reason to use Drifting on mobile: authors can keep
creating while walking, commuting, resting, or whenever typing is inconvenient.

## Desired experience

1. The author starts a voice capture from Project Home or the current paper.
2. Drifting turns the speech into an editable transcript.
3. AI decides whether it is a setting, character note, plot idea, TODO, or a
   change to existing prose.
4. Drifting finds the relevant project context and makes the smallest useful
   update.
5. The author sees a short list of where the capture was placed and can open,
   keep, reject, or undo each change.

If Drifting is unsure, it should preserve the capture as an Inspiration and
suggest possible destinations instead of guessing.

## Product principles

- Never lose a capture because the network, AI, or app session failed.
- Preserve the author's meaning and voice; only lightly clean transcription,
  repetition, and broken sentences unless more rewriting is requested.
- Do not silently make large, contradictory, or destructive changes.
- Show exactly which chapters, elements, storylines, or notes were changed.
- Do not retain raw audio by default.
- Voice capture is an explicit author action, never ambient listening.

## TODO

- [ ] Prototype the workflow with system keyboard dictation before building a
      custom recording system.
- [ ] Add a clear voice-capture entry on Project Home and the active paper.
- [ ] Support automatic routing to chapters, Inspirations, elements,
      storylines, project settings, and TODOs.
- [ ] Add a concise result screen showing every destination and change.
- [ ] Preserve uncertain captures without forcing them into canon.
- [ ] Test Chinese names, long spoken passages, interruption, offline failure,
      and real iOS/Android devices.

This document records a future product direction. It does not claim that
Drifting currently supports voice capture or automatic mobile editing.
