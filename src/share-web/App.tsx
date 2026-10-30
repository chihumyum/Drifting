import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import { KindMark } from '../renderer/components/ui/KindMark';
import type { KindMarkKind } from '../renderer/components/ui/kind-mark';
import { shareBlockText, type ShareBlock, type ShareCommentAnchor, type ShareDocument, type ShareEntity } from '../shared/share-document';
import { EntityCard } from './EntityCard';
import { useEntityCard } from './entity-card-state';
import { OutlineRail } from './OutlineRail';
import { outlineOf } from './document-outline';
import { useCommentSand } from './comment-sand';
import { anchorForSelection, comparePoints, locateAnchor, tokenFromPath, type BlockPoint, type LocatedAnchor } from './anchor';
import { accountApi, readerApi, ReaderError, type ReaderComment, type ReaderPage } from './api';
import { AuthPanel } from './AuthPanel';
import { errorText, formatTime, t } from './i18n';

/** New comments and revisions reach an open page within this long. */
const POLL_MS = 10_000;

type LoadedPage = ReaderPage & { document: ShareDocument };

export function App() {
  const token = useMemo(() => tokenFromPath(window.location.pathname), []);
  const [page, setPage] = useState<LoadedPage | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>(token ? 'loading' : 'missing');
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pageRef = useRef<LoadedPage | null>(null);
  useEffect(() => { pageRef.current = page; }, [page]);

  const apply = useCallback((next: ReaderPage, background: boolean) => {
    const current = pageRef.current;
    const document = next.document ?? current?.document;
    if (!document) return;
    if (background && next.document && current && next.share.revision !== current.share.revision) {
      setNotice(t.updatedNow);
    }
    const loaded = { ...next, document };
    pageRef.current = loaded;
    setPage(loaded);
    setState('ready');
  }, []);

  const fail = useCallback((error: unknown, background: boolean) => {
    if (error instanceof ReaderError && error.status === 404) setState('missing');
    else if (!background) setState('failed');
  }, []);

  /** Background refresh: the copy only when its revision changed, and comments. */
  const load = useCallback(async () => {
    if (!token) return;
    try {
      apply(await readerApi.page(token, pageRef.current?.share.revision), true);
    } catch (error) {
      fail(error, true);
    }
  }, [apply, fail, token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    readerApi.page(token).then(
      next => { if (!cancelled) apply(next, false); },
      error => { if (!cancelled) fail(error, false); },
    );
    return () => { cancelled = true; };
  }, [apply, fail, token, attempt]);

  useEffect(() => {
    if (state !== 'ready') return;
    const poll = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [load, state]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (page) document.title = `${page.document.title || page.share.title} · Drifting`;
  }, [page]);

  if (state === 'loading') return <Status text={t.loading} />;
  if (state === 'missing') return <Status text={t.notFound} />;
  if (state === 'failed' || !page || !token) {
    return <Status text={t.loadFailed} action={<button type="button" className="button" onClick={() => { setState('loading'); setAttempt(value => value + 1); }}>{t.retry}</button>} />;
  }
  return <Reader token={token} page={page} notice={notice} reload={load} onPage={setPage} />;
}

function Status({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <main className="status">
      <p>{text}</p>
      {action}
    </main>
  );
}

interface ReaderProps {
  token: string;
  page: LoadedPage;
  notice: string | null;
  reload: () => Promise<void>;
  onPage: (page: LoadedPage) => void;
}

interface Draft {
  anchor: ShareCommentAnchor;
  located: LocatedAnchor;
}

function Reader({ token, page, notice, reload, onPage }: ReaderProps) {
  const articleRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { document: doc, comments, viewer, share } = page;
  const [selection, setSelection] = useState<{ draft: Draft; rect: DOMRect } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const wide = useMediaQuery('(min-width: 1080px)');
  const roomy = useMediaQuery('(min-width: 1260px)');
  const hasOutline = useMemo(() => outlineOf(doc.blocks).length > 0, [doc.blocks]);
  const outline = roomy && hasOutline;
  const card = useEntityCard(articleRef, scrollRef);
  const cardEntity = card ? doc.entities?.[card.key] : undefined;

  const located = useMemo(() => {
    const result = new Map<string, LocatedAnchor | null>();
    for (const comment of comments) result.set(comment.id, locateAnchor(doc.blocks, comment.anchor));
    return result;
  }, [comments, doc.blocks]);

  const ordered = useMemo(() => [...comments].sort((a, b) => {
    const left = located.get(a.id);
    const right = located.get(b.id);
    if (left && right) return comparePoints(left.start, right.start) || a.createdAt.localeCompare(b.createdAt);
    if (left || right) return left ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  }), [comments, located]);

  useSelectionTracking(articleRef, scrollRef, doc.blocks, share.commentsEnabled, setSelection);
  useCommentSand(scrollRef, comments, activeId, draft?.anchor ?? null);

  const startComment = () => {
    if (!selection) return;
    setDraft(selection.draft);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    setSheetOpen(true);
  };

  const posted = (comment: ReaderComment) => {
    onPage({ ...page, comments: [...page.comments, comment] });
    setDraft(null);
    setActiveId(comment.id);
  };

  const withdrawn = (id: string) => {
    onPage({ ...page, comments: page.comments.filter(comment => comment.id !== id) });
  };

  const reveal = (id: string) => {
    setActiveId(id);
    const at = located.get(id);
    if (!at) return;
    articleRef.current?.querySelector<HTMLElement>(`[data-block-index="${at.start.index}"]`)
      ?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  const rail = (
    <CommentRail
      token={token}
      comments={ordered}
      located={located}
      blocks={doc.blocks}
      viewer={viewer}
      commentsEnabled={share.commentsEnabled}
      draft={draft}
      activeId={activeId}
      onActive={setActiveId}
      onReveal={reveal}
      onCancelDraft={() => setDraft(null)}
      onPosted={posted}
      onWithdrawn={withdrawn}
      onSignedIn={() => void reload()}
    />
  );

  return (
    <div className={`reader${outline ? ' reader--outline' : ''}`}>
      <header className="topbar">
        <span className="topbar__brand">Drifting</span>
        <span className="topbar__account">
          {viewer ? (
            <>
              <span>{t.signedInAs(viewer.name)}</span>
              <button type="button" className="button button--text" onClick={() => void accountApi.signOut().finally(() => void reload())}>{t.signOut}</button>
            </>
          ) : null}
        </span>
      </header>
      <div className="reader__body">
        {outline && <OutlineRail blocks={doc.blocks} />}
        <div ref={scrollRef} className="reader__scroll">
          <div className="reader__columns">
            <div className="reader__spread editor__spread">
              <article className="sheet" aria-labelledby="share-title">
                <Folio document={doc} />
                <h1 id="share-title" className="sheet__title">{doc.title || share.title}</h1>
                <p className="sheet__meta">
                  <span>{t.sharedBy(share.ownerName)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{t.updatedAt(formatTime(share.publishedAt))}</span>
                  {!share.commentsEnabled && <><span aria-hidden="true">·</span><span>{t.commentsClosed}</span></>}
                </p>
                <div ref={articleRef} className="prose">
                  {doc.blocks.map((block, index) => (
                    <BlockView key={`${block.id ?? 'x'}-${index}`} block={block} index={index} entities={doc.entities}
                      openEntity={card?.key ?? null} />
                  ))}
                </div>
              </article>
            </div>
            {wide && <aside className="rail" aria-label={t.comments}>{rail}</aside>}
          </div>
        </div>
      </div>
      {!wide && <button type="button" className="sheet-toggle button" onClick={() => setSheetOpen(true)}>{t.commentCount(comments.length)}</button>}
      {!wide && sheetOpen && (
        <div className="bottom-sheet" role="dialog" aria-label={t.comments}>
          <div className="bottom-sheet__head">
            <strong>{t.comments}</strong>
            <button type="button" className="button button--text" onClick={() => setSheetOpen(false)}>{t.close}</button>
          </div>
          {rail}
        </div>
      )}
      {selection && createPortal(
        <SelectionButton rect={selection.rect} onComment={startComment} />,
        document.body,
      )}
      {card && cardEntity && <EntityCard open={card} entity={cardEntity} />}
      {notice && <div className="notice" role="status">{notice}</div>}
    </div>
  );
}

const FOLIO_MARK: Record<ShareDocument['kind'], KindMarkKind> = {
  chapter: 'storyline', drift: 'drift-group', element: 'category', storyline: 'storyline', category: 'category',
};

/** The editor page's folio: 「第 N 章」 or the kind, the coloured line it belongs to, the word count. */
function Folio({ document: doc }: { document: ShareDocument }) {
  const folio = doc.folio;
  return (
    <p className="sheet__folio" aria-hidden="true">
      <span>{doc.kind === 'chapter' && folio?.chapter ? t.chapterNumber(folio.chapter) : t.kinds[doc.kind]}</span>
      {folio?.line && (
        <span>
          <KindMark kind={FOLIO_MARK[doc.kind]} color={folio.line.color} className="is-inline" />
          {folio.line.name}
        </span>
      )}
      {folio?.words !== undefined && <span>{t.words(folio.words)}</span>}
    </p>
  );
}

interface BlockViewProps {
  block: ShareBlock;
  index: number;
  entities: ShareDocument['entities'];
  /** Re-renders only the block holding the open link. */
  openEntity: string | null;
}

const BlockView = memo(function BlockView({ block, index, entities, openEntity }: BlockViewProps) {
  const className = [
    block.quote ? 'is-quote' : '',
    block.align ? `align-${block.align}` : '',
  ].filter(Boolean).join(' ') || undefined;
  const style = block.indent ? { marginInlineStart: `${block.indent * 2}em` } : undefined;
  // Block ids let the outline and the comment sand find their anchors, as in the editor.
  const id = block.id ?? undefined;
  if (block.type === 'rule') return <hr data-block-index={index} data-block-id={id} />;
  const runs = block.runs.map((run, key) => {
    if (run.br) return <br key={key} />;
    let node: ReactNode = run.text;
    for (const mark of run.marks ?? []) {
      node = mark === 'bold' ? <strong>{node}</strong>
        : mark === 'italic' ? <em>{node}</em>
          : mark === 'strike' ? <s>{node}</s> : <u>{node}</u>;
    }
    const entity: ShareEntity | undefined = run.entity ? entities?.[run.entity] : undefined;
    if (entity && run.entity) {
      const open = openEntity === run.entity;
      node = (
        <span
          className={`entity-link entity-link--${entity.kind}${open ? ' is-open' : ''}`}
          data-entity={run.entity}
          tabIndex={0}
          aria-describedby={open ? 'entity-card' : undefined}
          style={entity.color ? ({ '--entity-link-color': entity.color } as CSSProperties) : undefined}
        >
          {node}
        </span>
      );
    }
    if (run.href) node = <a href={run.href} target="_blank" rel="noopener noreferrer nofollow">{node}</a>;
    return <span key={key}>{node}</span>;
  });
  if (block.type === 'heading') {
    const Tag = (`h${(block.level ?? 3) + 1}`) as 'h2' | 'h3' | 'h4';
    return <Tag data-block-index={index} data-block-id={id} className={className} style={style}>{runs}</Tag>;
  }
  return <p data-block-index={index} data-block-id={id} className={className} style={style}>{runs.length ? runs : <br />}</p>;
}, (before, after) => before.block === after.block && before.index === after.index && before.entities === after.entities
  && (before.openEntity === after.openEntity
    || !before.block.runs.some(run => run.entity && (run.entity === before.openEntity || run.entity === after.openEntity))));

function SelectionButton({ rect, onComment }: { rect: DOMRect; onComment: () => void }) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const top = coarse ? rect.bottom + 12 : rect.top - 44;
  const left = Math.min(Math.max(rect.left + rect.width / 2, 48), window.innerWidth - 48);
  return (
    <button
      type="button"
      className="selection-button button button--primary"
      style={{ top: Math.max(8, top), left }}
      onMouseDown={event => event.preventDefault()}
      onClick={onComment}
    >
      {t.addComment}
    </button>
  );
}

interface RailProps {
  token: string;
  comments: ReaderComment[];
  located: Map<string, LocatedAnchor | null>;
  blocks: readonly ShareBlock[];
  viewer: ReaderPage['viewer'];
  commentsEnabled: boolean;
  draft: Draft | null;
  activeId: string | null;
  onActive: (id: string | null) => void;
  onReveal: (id: string) => void;
  onCancelDraft: () => void;
  onPosted: (comment: ReaderComment) => void;
  onWithdrawn: (id: string) => void;
  onSignedIn: () => void;
}

function CommentRail(props: RailProps) {
  const { comments, draft } = props;
  return (
    <div className="comments">
      {draft && <Composer {...props} draft={draft} />}
      <ol className="comments__list">
        {comments.map(comment => (
          <CommentCard key={comment.id} {...props} comment={comment} />
        ))}
      </ol>
    </div>
  );
}

function Composer({ token, draft, viewer, onCancelDraft, onPosted, onSignedIn }: RailProps & { draft: Draft }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (viewer) inputRef.current?.focus(); }, [viewer]);
  const submit = async () => {
    if (busy || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onPosted(await readerApi.comment(token, body.trim(), draft.anchor));
    } catch (failure) {
      if (failure instanceof ReaderError && failure.code === 'NEEDS_SIGN_IN') onSignedIn();
      setError(errorText(failure instanceof ReaderError ? failure.code : 'fallback'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card card--draft">
      <blockquote className="card__quote">{draft.anchor.selectedText}</blockquote>
      {viewer ? (
        <>
          <textarea
            ref={inputRef}
            className="composer__input"
            aria-label={t.placeholder}
            placeholder={t.placeholder}
            maxLength={4000}
            value={body}
            onChange={event => setBody(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
              if (event.key === 'Escape') onCancelDraft();
            }}
          />
          {error && <p className="auth__error" role="alert">{error}</p>}
          <div className="card__actions">
            <button type="button" className="button button--text" onClick={onCancelDraft}>{t.cancel}</button>
            <button type="button" className="button button--primary" disabled={busy || !body.trim()} onClick={() => void submit()}>
              {busy ? t.posting : t.post}
            </button>
          </div>
        </>
      ) : (
        <>
          <AuthPanel onSignedIn={onSignedIn} />
          <div className="card__actions">
            <button type="button" className="button button--text" onClick={onCancelDraft}>{t.cancel}</button>
          </div>
        </>
      )}
    </section>
  );
}

function CommentCard({ token, comment, located, activeId, onActive, onReveal, onWithdrawn }: RailProps & { comment: ReaderComment }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const moved = located.get(comment.id) === null;
  const withdraw = async () => {
    if (!confirming) { setConfirming(true); return; }
    setBusy(true);
    try {
      await readerApi.withdraw(token, comment.id);
      onWithdrawn(comment.id);
    } catch {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <li
      className={`card${comment.status === 'resolved' ? ' card--resolved' : ''}${activeId === comment.id ? ' card--active' : ''}`}
      onMouseEnter={() => onActive(comment.id)}
      onMouseLeave={() => onActive(null)}
    >
      <button type="button" className="card__target" onClick={() => onReveal(comment.id)}>
        <span className="card__head">
          <strong>{comment.mine ? t.you : comment.authorName}</strong>
          <span>{formatTime(comment.createdAt)}</span>
          {comment.status === 'resolved' && <span className="card__badge">{t.resolved}</span>}
          {moved && <span className="card__badge">{t.passageChanged}</span>}
        </span>
        <span className="card__quote">{comment.anchor.selectedText}</span>
        <span className="card__body">{comment.body}</span>
      </button>
      {comment.mine && (
        <div className="card__actions">
          <button type="button" className="button button--text" disabled={busy} onClick={() => void withdraw()} onBlur={() => setConfirming(false)}>
            {confirming ? `${t.withdraw}?` : t.withdraw}
          </button>
        </div>
      )}
    </li>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const change = () => setMatches(list.matches);
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  }, [query]);
  return matches;
}

/** Character offset of a DOM point within a block element's plain text. */
function offsetIn(block: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(block, 0);
  range.setEnd(container, offset);
  return range.toString().length;
}

function useSelectionTracking(
  articleRef: React.RefObject<HTMLDivElement | null>,
  scrollRef: React.RefObject<HTMLDivElement | null>,
  blocks: readonly ShareBlock[],
  enabled: boolean,
  onSelection: (value: { draft: Draft; rect: DOMRect } | null) => void,
) {
  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const update = () => {
      timer = 0;
      const root = articleRef.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) { onSelection(null); return; }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer) && !range.intersectsNode(root)) { onSelection(null); return; }
      const elements = [...root.querySelectorAll<HTMLElement>('[data-block-index]')].filter(element => range.intersectsNode(element));
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) { onSelection(null); return; }
      const start: BlockPoint = {
        index: Number(first.dataset.blockIndex),
        offset: first.contains(range.startContainer) ? offsetIn(first, range.startContainer, range.startOffset) : 0,
      };
      const end: BlockPoint = {
        index: Number(last.dataset.blockIndex),
        offset: last.contains(range.endContainer)
          ? offsetIn(last, range.endContainer, range.endOffset)
          : shareBlockText(blocks[Number(last.dataset.blockIndex)]!).length,
      };
      const anchor = anchorForSelection(blocks, start, end);
      if (!anchor) { onSelection(null); return; }
      onSelection({ draft: { anchor, located: { start, end } }, rect: range.getBoundingClientRect() });
    };
    // Settle while a selection is being dragged out before showing the button.
    const schedule = () => { if (!timer) timer = window.setTimeout(update, 60); };
    const scroller = scrollRef.current;
    document.addEventListener('selectionchange', schedule);
    scroller?.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('selectionchange', schedule);
      scroller?.removeEventListener('scroll', schedule);
    };
  }, [articleRef, scrollRef, blocks, enabled, onSelection]);
}
