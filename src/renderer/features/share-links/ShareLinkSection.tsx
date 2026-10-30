import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { Switch } from '../../components/ui/Switch';
import { useAuthStore } from '../../store/auth';
import { useOpenSignIn } from '../auth/auth-dialog-store';
import { ShareLinkError, shareLinkUrl } from './share-link-api';
import { useShareLinkStore } from './share-link-store';
import type { ShareTarget } from './share-source';

type Busy = 'create' | 'comments' | 'stop' | null;

/**
 * The link part of the share dialog (docs/share-links.md): one link per
 * entity, readable by anyone holding it; signed-in readers comment and the
 * comments come back into this library. Hosted-configured builds only.
 */
export function ShareLinkSection({ target }: { target: ShareTarget }) {
  const { t } = useTranslation();
  const hostedStatus = useAuthStore(state => state.hostedStatus);
  const openSignIn = useOpenSignIn();
  const link = useShareLinkStore(state => state.shares.find(item =>
    item.projectId === target.projectId && item.entityKind === target.entityKind && item.entityId === target.entityId));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [feedback, setFeedback] = useState<'copied' | 'failed' | 'reauth' | null>(null);
  const connected = hostedStatus === 'connected';

  useEffect(() => {
    if (!connected) return;
    let alive = true;
    void useShareLinkStore.getState().refresh().catch(() => undefined).finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [connected]);

  const run = async (kind: Exclude<Busy, null>, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setFeedback(null);
    try {
      await work();
    } catch (error) {
      setFeedback(error instanceof ShareLinkError && error.code === 'needs-reauth' ? 'reauth' : 'failed');
    } finally {
      setBusy(null);
    }
  };

  /** A new link is copied as a convenience; only an explicit copy reports failure. */
  const copy = async (url: string, quiet = false) => {
    try {
      await navigator.clipboard.writeText(url);
      setFeedback('copied');
    } catch {
      if (!quiet) setFeedback('failed');
    }
  };

  if (!connected) {
    // Offline or still checking the session: the link waits; it does not need a new sign-in.
    const signedOut = hostedStatus === 'signed-out' || hostedStatus === 'needs-reauth';
    return (
      <section className="share-link">
        <div className="share-link__head">
          <strong>{t('shareLink.title')}</strong>
          <span>{t(signedOut ? 'shareLink.signedOut' : 'shareLink.unavailable')}</span>
        </div>
        {signedOut && (
          <div className="share-link__row">
            <Button onClick={() => openSignIn('signin')}><BrushIcon name="gate-in" size={14} />{t('shareLink.signIn')}</Button>
          </div>
        )}
      </section>
    );
  }

  const url = link ? shareLinkUrl(link.token) : null;
  return (
    <section className="share-link" aria-busy={!loaded}>
      <div className="share-link__head">
        <strong>{t('shareLink.title')}</strong>
        <span>{t(link ? 'shareLink.liveHint' : 'shareLink.createHint')}</span>
      </div>
      {link && url ? (
        <>
          <div className="share-link__row">
            <input className="share-link__url glass glass--rest glass--still glass--field" readOnly value={url}
              aria-label={t('shareLink.url')} onFocus={event => event.currentTarget.select()} />
            <Button variant="primary" onClick={() => void copy(url)}><BrushIcon name="copy" size={14} />{t('shareLink.copy')}</Button>
          </div>
          <div className="share-link__row share-link__row--settings">
            <label className="share-link__toggle">
              <Switch size="sm" checked={link.commentsEnabled} disabled={busy !== null}
                aria-label={t('shareLink.allowComments')}
                onCheckedChange={next => void run('comments', () => useShareLinkStore.getState().setCommentsEnabled(link.id, next))} />
              <span>{t('shareLink.allowComments')}</span>
            </label>
            <span className="share-link__meta">{t('shareLink.revision', { revision: link.revision })}</span>
            <Button variant="danger" disabled={busy !== null} onBlur={() => setConfirmStop(false)}
              onClick={() => {
                if (!confirmStop) { setConfirmStop(true); return; }
                setConfirmStop(false);
                void run('stop', () => useShareLinkStore.getState().stop(link.id));
              }}>
              {t(confirmStop ? 'shareLink.confirmStop' : busy === 'stop' ? 'shareLink.stopping' : 'shareLink.stop')}
            </Button>
          </div>
        </>
      ) : (
        <div className="share-link__row">
          <Button variant="primary" disabled={!loaded || busy !== null}
            onClick={() => void run('create', async () => {
              const created = await useShareLinkStore.getState().publish(target);
              await copy(shareLinkUrl(created.token), true);
            })}>
            <BrushIcon name="share" size={14} />{t(busy === 'create' ? 'shareLink.creating' : 'shareLink.create')}
          </Button>
        </div>
      )}
      {feedback && (
        <p className="share-link__feedback" role={feedback === 'copied' ? 'status' : 'alert'}>
          {t(`shareLink.${feedback}`)}
        </p>
      )}
    </section>
  );
}
