import { describe, expect, it } from 'vitest';
import { IMMERSIVE_STAY_SELECTOR, isPressElsewhere, isTypingInput, isTypingKey } from './auto-immersion';

const key = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: 'Enter',
  keyCode: 13,
  isComposing: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...overrides,
});

/** A press target inside (or outside) the workspace, under (or off) the text. */
function press(within: string | null, inRoot = true) {
  const target = { closest: (selector: string) => (selector === IMMERSIVE_STAY_SELECTOR && within ? {} : null) };
  const root = { contains: (node: unknown) => inRoot && node === target };
  return { target, root };
}

describe('打字时自动沉浸 (docs/editor/immersive-writing.md)', () => {
  it('counts written text and new lines, not pastes, drops, replacements or deletions', () => {
    for (const inputType of ['insertText', 'insertParagraph', 'insertLineBreak']) {
      expect(isTypingInput({ inputType, isComposing: false }), inputType).toBe(true);
    }
    for (const inputType of ['insertFromPaste', 'insertFromPasteAsQuotation', 'insertFromDrop', 'insertFromYank',
      'insertReplacementText', 'insertLink', 'deleteContentBackward', 'historyUndo', 'formatBold']) {
      expect(isTypingInput({ inputType, isComposing: false }), inputType).toBe(false);
    }
    expect(isTypingInput({})).toBe(false);
  });

  it('never begins while a composition is being written; its commit counts', () => {
    expect(isTypingInput({ inputType: 'insertText', isComposing: true })).toBe(false);
    expect(isTypingInput({ inputType: 'insertCompositionText', isComposing: false })).toBe(false);
    expect(isTypingInput({ inputType: 'insertFromComposition', isComposing: false })).toBe(false);
    expect(isTypingKey(key({ isComposing: true }))).toBe(false);
    // WebKit's keydown that commits a composition.
    expect(isTypingKey(key({ keyCode: 229 }))).toBe(false);
  });

  it('takes Enter and Shift+Enter as writing, not shortcuts or other keys', () => {
    expect(isTypingKey(key())).toBe(true);
    expect(isTypingKey(key({ metaKey: true }))).toBe(false);
    expect(isTypingKey(key({ ctrlKey: true }))).toBe(false);
    expect(isTypingKey(key({ altKey: true }))).toBe(false);
    expect(isTypingKey(key({ key: 'ArrowDown', keyCode: 40 }))).toBe(false);
    expect(isTypingKey(key({ key: 'Escape', keyCode: 27 }))).toBe(false);
  });

  it('ends a typed sitting on a press in the workspace off the text and the way out', () => {
    const margin = press(null);
    expect(isPressElsewhere(margin.target, margin.root)).toBe(true);
    const text = press('.ProseMirror');
    expect(isPressElsewhere(text.target, text.root)).toBe(false);
    // A card, menu or dialog portaled to body is not the workspace.
    const portaled = press(null, false);
    expect(isPressElsewhere(portaled.target, portaled.root)).toBe(false);
    expect(isPressElsewhere(null, margin.root)).toBe(false);
    expect(IMMERSIVE_STAY_SELECTOR).toBe('.ProseMirror, .immersive-writing-control--stage');
  });
});
