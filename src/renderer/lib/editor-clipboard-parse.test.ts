import { describe, expect, it } from 'vitest';
import { DOMParser as ProseMirrorDOMParser, type Node as ProseMirrorNode } from '@tiptap/pm/model';

import { schemaForProfile } from './editor-schema-profile';

// The unit tests run without a DOM. These objects carry the few properties
// ProseMirror's parser and Tiptap's attribute readers touch on the nodes below.
interface FakeNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  parentNode: FakeNode | null;
  firstChild: FakeNode | null;
  nextSibling: FakeNode | null;
  previousSibling: FakeNode | null;
  childNodes: FakeNode[];
}

function leaf(nodeType: number, nodeName: string, nodeValue: string): FakeNode {
  return { nodeType, nodeName, nodeValue, parentNode: null, firstChild: null, nextSibling: null, previousSibling: null, childNodes: [] };
}

const text = (value: string) => leaf(3, '#text', value);
const comment = (value: string) => leaf(8, '#comment', value);

function element(tag: string, attributes: Record<string, string>, children: FakeNode[]): FakeNode {
  const node = {
    ...leaf(1, tag.toUpperCase(), ''),
    nodeValue: null,
    tagName: tag.toUpperCase(),
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: children,
    firstChild: children[0] ?? null,
    style: { length: 0, whiteSpace: '', textAlign: '', getPropertyValue: () => '' },
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    matches: (selector: string) => selector === tag,
  };
  children.forEach((child, index) => {
    child.parentNode = node;
    child.previousSibling = children[index - 1] ?? null;
    child.nextSibling = children[index + 1] ?? null;
  });
  return node;
}

function shape(node: ProseMirrorNode): string {
  let inline = '';
  node.forEach((child) => {
    inline += child.isText ? child.text : `<${child.type.name}>`;
  });
  return `${node.type.name}[${inline}]`;
}

describe('clipboard HTML copied in the app', () => {
  // Chromium on Windows (WebView2) hands a paste the copied fragment as
  // "<html>\r\n<body>\r\n<!--StartFragment-->…<!--EndFragment-->\r\n</body>\r\n</html>",
  // and prosemirror-view 1.42 parses clipboard HTML inside a <body>. Text
  // copied from a ProseMirror editor is parsed with whitespace preserved, so a
  // prosemirror-model older than 1.25.11 read those line breaks as content:
  // two hard breaks above and below every paste of text copied in the app.
  it('does not read the line breaks around the Windows clipboard fragment as content', () => {
    const body = element('body', {}, [
      text('\n\n'),
      comment('StartFragment'),
      element('p', { 'data-pm-slice': '1 1 []' }, [text('二段戊己')]),
      comment('EndFragment'),
      text('\n\n'),
    ]);

    const slice = ProseMirrorDOMParser.fromSchema(schemaForProfile('prose')).parseSlice(body as unknown as Node, {
      preserveWhitespace: true,
    });

    const blocks: string[] = [];
    slice.content.forEach((node) => blocks.push(shape(node)));
    expect(blocks).toEqual(['paragraph[二段戊己]']);
  });
});
