import { describe, it, expect } from 'vitest';

import { getStaticChapterSchema } from './chapter-static-html';

// The static read-through serializes chapter JSON through this schema. If a
// schema-bearing extension were dropped — most dangerously the `entityLink`
// mark — DOMSerializer would throw at runtime and the row would silently fall
// back to plain text. This guards the schema's completeness without needing a
// DOM (schema construction is pure).
describe('getStaticChapterSchema', () => {
  const schema = getStaticChapterSchema();

  it('builds successfully', () => {
    expect(schema).not.toBeNull();
  });

  it('carries every node/mark a chapter can contain', () => {
    expect(schema).not.toBeNull();
    const nodes = schema!.nodes;
    const marks = schema!.marks;
    // Core block nodes.
    expect(nodes.doc).toBeDefined();
    expect(nodes.paragraph).toBeDefined();
    expect(nodes.heading).toBeDefined();
    expect(nodes.text).toBeDefined();
    // Marks — including the custom entityLink, the one most likely to be missed.
    expect(marks.bold).toBeDefined();
    expect(marks.italic).toBeDefined();
    expect(marks.underline).toBeDefined();
    expect(marks.link).toBeDefined();
    expect(marks.entityLink).toBeDefined();
  });

  it('omits the lists/code nodes the writing surface disables', () => {
    expect(schema).not.toBeNull();
    expect(schema!.nodes.bulletList).toBeUndefined();
    expect(schema!.nodes.codeBlock).toBeUndefined();
  });
});
