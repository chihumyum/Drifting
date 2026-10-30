import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { inArray } from 'drizzle-orm';
import { Button } from '../../components/ui/Button';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { EmptyState } from '../../components/ui/EmptyState';
import { GhostIconButton } from '../../components/ui/GhostIconButton';
import { KindMark } from '../../components/ui/KindMark';
import type { KindMarkKind } from '../../components/ui/kind-mark';
import { LoadingStatus } from '../../components/ui/LoadingStatus';
import { ModalBody, ModalCard, ModalHeader, ModalRoot } from '../../components/ui/Modal';
import { Switch } from '../../components/ui/Switch';
import { getDbIfInitialized } from '../../lib/db';
import { ProjectTable } from '../../schema/drizzle';
import { workspaceUrlFor } from '../workspace/navigation/workspace-route';
import { shareLinkUrl, type ShareEntityKind, type ShareLink } from './share-link-api';
import { useShareLinkStore } from './share-link-store';
import '../../../styles/share-links.css';

const MARK: Record<ShareEntityKind, KindMarkKind> = {
  node: 'chapter',
  element: 'element',
  storyline: 'storyline',
  category: 'category',
};

/** Names of the projects the links belong to, from this device's library. */
async function readProjectNames(ids: readonly string[]): Promise<Map<string, string>> {
  const db = getDbIfInitialized();
  if (!db || ids.length === 0) return new Map();
  const rows = await db.select({ id: ProjectTable.id, name: ProjectTable.name }).from(ProjectTable)
    .where(inArray(ProjectTable.id, [...ids]));
  return new Map(rows.map(row => [row.id, row.name]));
}

/**
 * Every link the account shares, grouped by project: open the shared entity,
 * turn comments on or off, copy the link, stop sharing.
 */
export function ShareLinksDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const shares = useShareLinkStore(state => state.shares);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [projects, setProjects] = useState<Map<string, string>>(new Map());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    useShareLinkStore.getState().refresh().then(
      async links => {
        const names = await readProjectNames([...new Set(links.map(link => link.projectId))]);
        if (!alive) return;
        setProjects(names);
        setState('ready');
      },
      () => { if (alive) setState('failed'); },
    );
    return () => { alive = false; };
  }, [attempt]);

  // Projects on this device first; links of projects it does not hold share one group at the end.
  const groups = useMemo(() => {
    const byProject = new Map<string, ShareLink[]>();
    const elsewhere: ShareLink[] = [];
    for (const link of shares) {
      if (projects.has(link.projectId)) byProject.set(link.projectId, [...(byProject.get(link.projectId) ?? []), link]);
      else elsewhere.push(link);
    }
    const known = [...byProject.entries()].map(([projectId, links]) => ({ key: projectId, name: projects.get(projectId)!, links }));
    return elsewhere.length ? [...known, { key: '', name: null, links: elsewhere }] : known;
  }, [projects, shares]);

  const open = (link: ShareLink) => {
    const url = workspaceUrlFor(link.projectId, { entityType: link.entityKind, id: link.entityId });
    if (!url) return;
    onClose();
    navigate(url);
  };

  return (
    <ModalRoot onClose={onClose} ariaLabel={t('shareLink.listTitle')} className="share-links-root">
      <ModalCard width={640}>
        <ModalHeader title={t('shareLink.listTitle')} onClose={onClose} closeLabel={t('common.close')} />
        <ModalBody className="share-list">
          {state === 'loading' && shares.length === 0 ? (
            <div className="share-list__placeholder"><LoadingStatus label={t('shareLink.listLoading')} /></div>
          ) : state === 'failed' && shares.length === 0 ? (
            <div className="share-list__placeholder" role="alert">
              <p>{t('shareLink.failed')}</p>
              <Button onClick={() => { setState('loading'); setAttempt(value => value + 1); }}>
                <BrushIcon name="rotate" size={14} />{t('markdownShare.retry')}
              </Button>
            </div>
          ) : shares.length === 0 ? (
            <EmptyState icon="share" message={t('shareLink.listEmpty')} />
          ) : (
            groups.map(({ key, name, links }) => (
              <section key={key} className="share-list__group">
                <h3 className="share-list__project">{name ?? t('shareLink.otherProject')}</h3>
                <ul className="share-list__rows">
                  {links.map(link => (
                    <ShareLinkRow key={link.id} link={link} onOpen={projects.has(link.projectId) ? () => open(link) : undefined} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </ModalBody>
      </ModalCard>
    </ModalRoot>
  );
}

function ShareLinkRow({ link, onOpen }: { link: ShareLink; onOpen?: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null);

  useEffect(() => {
    if (feedback !== 'copied') return;
    const timer = window.setTimeout(() => setFeedback(null), 1600);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try { await work(); } catch { setFeedback('failed'); } finally { setBusy(false); }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareLinkUrl(link.token));
      setFeedback('copied');
    } catch {
      setFeedback('failed');
    }
  };

  const title = (
    <>
      <KindMark kind={MARK[link.entityKind]} seed={link.entityId} />
      <span className="share-list__title">{link.title}</span>
    </>
  );
  return (
    <li className="share-list__row">
      {onOpen
        ? <button type="button" className="share-list__open" onClick={onOpen} title={t('shareLink.open')}>{title}</button>
        : <span className="share-list__open">{title}</span>}
      <span className="share-list__meta">
        {feedback ? <span role={feedback === 'failed' ? 'alert' : 'status'}>{t(`shareLink.${feedback}`)}</span>
          : t('shareLink.revision', { revision: link.revision })}
      </span>
      <Switch size="sm" checked={link.commentsEnabled} disabled={busy}
        aria-label={t('shareLink.allowComments')} title={t('shareLink.allowComments')}
        onCheckedChange={next => void run(() => useShareLinkStore.getState().setCommentsEnabled(link.id, next))} />
      <GhostIconButton size="sm" icon={<BrushIcon name="copy" size={13} />} onClick={() => void copy()}
        aria-label={t('shareLink.copy')} title={t('shareLink.copy')} />
      <Button size="sm" variant="danger" disabled={busy} onBlur={() => setConfirmStop(false)}
        onClick={() => {
          if (!confirmStop) { setConfirmStop(true); return; }
          setConfirmStop(false);
          void run(() => useShareLinkStore.getState().stop(link.id));
        }}>
        {t(confirmStop ? 'shareLink.confirmStop' : 'shareLink.stop')}
      </Button>
    </li>
  );
}
