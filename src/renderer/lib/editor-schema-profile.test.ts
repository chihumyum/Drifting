import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';

import { profileForDocId, schemaForProfile } from './editor-schema-profile';
import { createYjsProseSeedState } from './agent/runtime/yjs-prose-command';
import { noteToMarkdown } from './note-markdown';

const NOTE_ONLY_NODES = ['taskList', 'taskItem', 'table', 'tableRow', 'tableHeader', 'tableCell', 'callout', 'materialEmbed', 'bulletList', 'orderedList', 'codeBlock'];

const richNote = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '调研' }] },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '找潮汐表' }] }] },
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '查年代' }] }] },
      ],
    },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '地点' }] }] },
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '年份' }] }] },
        ] },
        { type: 'tableRow', content: [
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '北岬|灯塔' }] }] },
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1891' }] }] },
        ] },
      ],
    },
    { type: 'callout', content: [{ type: 'paragraph', content: [{ type: 'text', text: '核对', marks: [{ type: 'highlight' }] }] }] },
    { type: 'materialEmbed', attrs: { libraryItemId: 'image-1' } },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '雾', marks: [{ type: 'bold' }] }] }] }] },
    { type: 'codeBlock', attrs: { language: 'txt' }, content: [{ type: 'text', text: 'raw | text' }] },
  ],
};

describe('editor schema profiles', () => {
  it('keeps the prose schema restrained and gives notes their richer blocks', () => {
    const prose = schemaForProfile('prose');
    const note = schemaForProfile('note');
    for (const name of NOTE_ONLY_NODES) {
      expect(prose.nodes[name], `prose must not declare ${name}`).toBeUndefined();
      expect(note.nodes[name], `note must declare ${name}`).toBeDefined();
    }
    expect(prose.marks.highlight).toBeUndefined();
    expect(note.marks.highlight).toBeDefined();
    expect(note.marks.entityLink).toBeDefined();
    // Every note container that can sit at the top level carries a block id.
    for (const name of ['taskList', 'table', 'callout', 'materialEmbed', 'taskItem', 'paragraph']) {
      expect(note.nodes[name]?.spec.attrs?.id, `${name} needs a block id`).toBeDefined();
    }
  });

  it('assigns the note profile to material note documents only', () => {
    expect(profileForDocId('library-item:abc')).toBe('note');
    for (const docId of ['node-content:a', 'element:a', 'storyline:a', 'category:a']) {
      expect(profileForDocId(docId)).toBe('prose');
    }
  });

  it('seeds a rich note deterministically with stable block ids', async () => {
    const json = JSON.stringify(richNote);
    const [first, second] = await Promise.all([
      createYjsProseSeedState(json, 'note'),
      createYjsProseSeedState(json, 'note'),
    ]);
    expect(first).toEqual(second);
    const document = new Y.Doc();
    Y.applyUpdate(document, first);
    const restored = yDocToProsemirrorJSON(document, 'default') as { content: Array<{ type: string; attrs?: { id?: unknown } }> };
    expect(restored.content.map((node) => node.type)).toEqual(richNote.content.map((node) => node.type));
    for (const node of restored.content) expect(typeof node.attrs?.id).toBe('string');
    document.destroy();
  });

  it('keeps a task item\'s TODO link through seeding', async () => {
    const linked = {
      type: 'doc',
      content: [{
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: false, todoId: 'todo-1' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '查年代' }] }] }],
      }],
    };
    expect(schemaForProfile('note').nodes.taskItem?.spec.attrs?.todoId).toBeDefined();
    const document = new Y.Doc();
    Y.applyUpdate(document, await createYjsProseSeedState(JSON.stringify(linked), 'note'));
    const restored = yDocToProsemirrorJSON(document, 'default') as { content: Array<{ content: Array<{ attrs: Record<string, unknown> }> }> };
    expect(restored.content[0]?.content[0]?.attrs).toMatchObject({ todoId: 'todo-1', checked: false });
    document.destroy();
  });

  it('refuses note-only blocks in a prose seed instead of dropping them', async () => {
    await expect(createYjsProseSeedState(JSON.stringify(richNote))).rejects.toThrow();
  });
});

describe('note Markdown', () => {
  it('renders tasks, GFM tables, callouts, highlights, embeds and code', () => {
    const markdown = noteToMarkdown(JSON.stringify(richNote), {
      embed: (id) => `[[materials/${id}|远景]]`,
    });
    expect(markdown).toBe([
      '## 调研',
      '- [x] 找潮汐表\n- [ ] 查年代',
      '| 地点 | 年份 |\n| --- | --- |\n| 北岬\\|灯塔 | 1891 |',
      '> [!note]\n> ==核对==',
      '[[materials/image-1|远景]]',
      '- **雾**',
      '```txt\nraw | text\n```',
    ].join('\n\n'));
  });

  it('keeps nested list structure and falls back for unknown embeds', () => {
    const nested = {
      type: 'doc',
      content: [
        { type: 'orderedList', attrs: { start: 3 }, content: [
          { type: 'listItem', content: [
            { type: 'paragraph', content: [{ type: 'text', text: '一' }] },
            { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '子项' }] }] }] },
          ] },
        ] },
        { type: 'materialEmbed', attrs: { libraryItemId: 'gone' } },
      ],
    };
    expect(noteToMarkdown(JSON.stringify(nested))).toBe('3. 一\n   - 子项\n\n［素材］');
  });
});
