# Editor title wrapping

Chapter and drift titles in `ChapterEditor`, including the active whole-book
chapter, wrap to the available width. The editable title uses the shared
`useAutosizeTextArea` hook: mounting, external title changes, typing and width
changes recalculate its height; shortening the title also shrinks it. Long
unbroken text wraps within the page instead of overflowing horizontally.

This is visual wrapping. Title values remain single-line strings, including
when multiline text is pasted. Blur and Enter keep the existing rename path;
Enter then focuses the prose. ArrowDown moves within wrapped title lines and
only enters prose when the caret is collapsed at the end of the title, without
Shift. Keyboard shortcuts leave composition events to the IME.

## Acceptance

`acceptance/title-wrapping.json` records source SHA-256 hashes and measured
browser geometry using synthetic titles. The isolated browser probe renders
the production title JSX, shared autosizing hook and stylesheet. It compares
the old single-line input with wrapped titles at 780 px and 380 px, then checks
unbroken text, shrinking, compact layout, read-only headings, ArrowDown, Enter,
composition events and multiline paste.

Editable title acceptance requires `scrollWidth <= width + 1` and
`scrollHeight <= height + 1`; the narrow title must be taller than the wide
title, and shortening must reduce its height. All recorded keyboard checks
must be true. The prose focus target and rename callback are synthetic: this
does not claim full Tauri, native IME or database-persistence acceptance.
