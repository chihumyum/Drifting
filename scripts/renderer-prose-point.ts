// Synthetic page for scripts/run-prose-point-acceptance.mjs: the real
// CommentSandPainter over a scroller of plain paragraphs with two anchored
// notes, fed the pointed set the way CommentAnchorHighlights feeds it.
import '../src/styles/index.css';
import '../src/styles/materials.css';
import '../src/styles/comments-review.css';
import type { Comment } from '../src/renderer/domain/comment';
import { getPointedCommentHighlights, subscribePointedCommentHighlights } from '../src/renderer/lib/comment-highlight';
import { CommentSandPainter } from '../src/renderer/lib/comment-sand';

const root = document.getElementById('root')!;
root.innerHTML = `<div class="editor-scroll" style="height:600px;width:800px;overflow-y:auto;position:relative">
  <div class="editor__spread" style="position:relative"><article class="page" style="width:600px;margin:40px auto;font:18px/1.8 serif">
    ${Array.from({ length: 12 }, (_, i) => `<p data-block-id="b${i}">Paragraph ${i}: the harbour lamps go out one by one while the keeper climbs the stair and counts the steps again.</p>`).join('')}
  </article></div></div>`;
const scrollEl = root.querySelector<HTMLElement>('.editor-scroll')!;
const now = new Date().toISOString();
const comment = (id: string, block: string, start: number, end: number, text: string): Comment => ({
  id, projectId: 'p', kind: 'note', targetKind: 'node', targetId: 'n', targetBlockId: block,
  targetBlockIdsJson: JSON.stringify([block]), authorKind: 'user', authorId: null, authorName: null,
  anchorJson: JSON.stringify({ selectedText: text, textAnchor: { startBlockId: block, startOffset: start, endBlockId: block, endOffset: end, text } }),
  bodyJson: '{}', status: 'open', priority: null, source: 'manual', metadataJson: null, resolvedAt: null, createdAt: now, updatedAt: now,
});
const text = (i: number) => `Paragraph ${i}: the harbour lamps go out one by one while the keeper climbs the stair and counts the steps again.`;
const sub = (i: number, word: string) => { const t = text(i); const s = t.indexOf(word); return [s, s + word.length] as const; };
const [a0, a1] = sub(2, 'the harbour lamps go out');
const [b0, b1] = sub(5, 'climbs the stair');
const comments = [comment('A', 'b2', a0, a1, 'the harbour lamps go out'), comment('B', 'b5', b0, b1, 'climbs the stair')];
const painter = new CommentSandPainter(scrollEl);
painter.attach();
const render = () => painter.update(comments, null, null, getPointedCommentHighlights());
subscribePointedCommentHighlights(render);
render();
Object.assign(window, { __PP__: {
  pointed: () => getPointedCommentHighlights(),
  marks: () => [...scrollEl.querySelectorAll<HTMLElement>('.comment-sand')].map((g) => ({
    cls: g.className, state: g.dataset.state,
    lines: [...g.querySelectorAll<HTMLElement>('.comment-sand__line')].map((l) => { const r = l.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }),
  })),
  scrollBy: (dy: number) => scrollEl.scrollBy({ top: dy }),
} });
