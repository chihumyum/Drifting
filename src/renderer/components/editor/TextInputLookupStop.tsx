import type { CSSProperties } from 'react';

// When the macOS input method asks WebKit for text whose range ends at the
// editor's final newline, WebKit walks forward one character at a time to the
// next caret candidate. Text in inactive `visibility: hidden` editor surfaces
// is not a candidate, so near a chapter's end every keystroke walked through
// the prose of every retained tab after the active one. This rendered,
// selectable zero-width character ends that walk inside the active surface.
// It inherits the surface's visibility, so a hidden surface's stop is inert.
// See docs/renderer-performance/ime-text-lookup.md.
const STOP_STYLE: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: 0,
  height: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
  userSelect: 'text',
  WebkitUserSelect: 'text',
};

export function TextInputLookupStop() {
  return (
    <span data-text-input-lookup-stop="" aria-hidden="true" style={STOP_STYLE}>
      {'​'}
    </span>
  );
}
