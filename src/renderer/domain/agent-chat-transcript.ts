import type { AgentChatMessage } from './agent-conversation';

const WIDTH = 32;
type Tree = readonly (Tree | AgentChatMessage)[];

function replaceInTree(tree: Tree, depth: number, index: number, message: AgentChatMessage): Tree {
  const copy = tree.slice();
  const slot = Math.floor(index / WIDTH ** depth) % WIDTH;
  copy[slot] = depth === 0 ? message : replaceInTree((tree[slot] ?? []) as Tree, depth - 1, index, message);
  return copy;
}

/** Immutable live projection. Updates share untouched tree branches; arrays are
 * materialized only at explicit display/storage boundaries, once per snapshot.
 * This object is renderer state, never the persisted conversation format. */
export class AgentChatTranscript {
  private cached: AgentChatMessage[] | undefined;
  private constructor(readonly length: number, private readonly depth: number, private readonly tree: Tree) {}

  static from(messages: readonly AgentChatMessage[]): AgentChatTranscript {
    if (messages.length <= WIDTH) return new AgentChatTranscript(messages.length, 0, messages.slice());
    let nodes: Tree[] = [];
    for (let start = 0; start < messages.length; start += WIDTH) nodes.push(messages.slice(start, start + WIDTH));
    let depth = 1;
    while (nodes.length > WIDTH) {
      const parents: Tree[] = [];
      for (let start = 0; start < nodes.length; start += WIDTH) parents.push(nodes.slice(start, start + WIDTH));
      nodes = parents; depth++;
    }
    return new AgentChatTranscript(messages.length, depth, nodes);
  }

  at(index: number): AgentChatMessage | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    let tree = this.tree;
    for (let depth = this.depth; depth > 0; depth--) tree = tree[Math.floor(index / WIDTH ** depth) % WIDTH] as Tree;
    return tree[index % WIDTH] as AgentChatMessage;
  }

  /** Search leaves directly so a historical tool lookup visits each row once,
   * rather than paying a root-to-leaf lookup for every candidate. */
  findLastIndex(predicate: (message: AgentChatMessage) => boolean): number {
    const visit = (tree: Tree, depth: number, start: number): number => {
      for (let slot = tree.length - 1; slot >= 0; slot--) {
        if (depth === 0) { if (predicate(tree[slot] as AgentChatMessage)) return start + slot; }
        else {
          const found = visit(tree[slot] as Tree, depth - 1, start + slot * WIDTH ** depth);
          if (found >= 0) return found;
        }
      }
      return -1;
    };
    return visit(this.tree, this.depth, 0);
  }

  replace(index: number, message: AgentChatMessage): AgentChatTranscript {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) throw new RangeError('Transcript index outside snapshot');
    if (this.at(index) === message) return this;
    return new AgentChatTranscript(this.length, this.depth, replaceInTree(this.tree, this.depth, index, message));
  }

  append(...messages: AgentChatMessage[]): AgentChatTranscript {
    if (!messages.length) return this;
    let length = this.length; let depth = this.depth; let tree = this.tree;
    for (const message of messages) {
      if (length === WIDTH ** (depth + 1)) { tree = [tree]; depth++; }
      tree = replaceInTree(tree, depth, length, message);
      length++;
    }
    return new AgentChatTranscript(length, depth, tree);
  }

  /** Read-only leaves preserve identity across edits to other tree branches. */
  forEachLeaf(visit: (messages: readonly AgentChatMessage[], start: number) => void): void {
    const walk = (tree: Tree, depth: number, start: number) => {
      if (depth === 0) visit(tree as readonly AgentChatMessage[], start);
      else for (let slot = 0; slot < tree.length; slot++) walk(tree[slot] as Tree, depth - 1, start + slot * WIDTH ** depth);
    };
    if (this.length) walk(this.tree, this.depth, 0);
  }

  [Symbol.iterator](): IterableIterator<AgentChatMessage> {
    let index = 0;
    let leaf = this.tree;
    const { length, depth, tree } = this;
    // Descend once per leaf, avoiding recursive generator delegation per row.
    return {
      [Symbol.iterator]() { return this; },
      next(): IteratorResult<AgentChatMessage> {
        if (index >= length) return { done: true, value: undefined };
        if (index % WIDTH === 0) {
          leaf = tree;
          for (let level = depth; level > 0; level--) leaf = leaf[Math.floor(index / WIDTH ** level) % WIDTH] as Tree;
        }
        return { done: false, value: leaf[index++ % WIDTH] as AgentChatMessage };
      },
    };
  }

  /** Callers treat this cached array and its message objects as immutable. */
  toArray(): AgentChatMessage[] {
    if (this.cached) return this.cached;
    const messages: AgentChatMessage[] = [];
    const visit = (tree: Tree, depth: number) => {
      if (depth === 0) { for (const message of tree) messages.push(message as AgentChatMessage); }
      else for (const child of tree) visit(child as Tree, depth - 1);
    };
    visit(this.tree, this.depth);
    this.cached = messages;
    return messages;
  }
}
