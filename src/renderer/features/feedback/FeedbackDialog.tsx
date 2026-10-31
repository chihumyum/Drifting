import { useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { Button } from '../../components/ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../../components/ui/Modal';
import { Switch } from '../../components/ui/Switch';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { crashFollowUpNotificationId } from '../../services/diagnostics/crash-follow-up-notifications';
import type { CrashFollowUp } from '../../services/diagnostics/crash-reporter';
import {
  FEEDBACK_MESSAGE_MAX,
  feedbackDelivery,
  feedbackEmailUrl,
  feedbackProblems,
  sendFeedback,
  type FeedbackDraft,
} from '../../services/diagnostics/feedback';
import { createSanitizedDiagnosticSummary } from '../../services/diagnostics/sanitized-summary';
import { UpdateService } from '../../services/update/update-service';
import { useAuthStore } from '../../store/auth';
import { useNotificationStore } from '../../store/notification-store';
import { useProductSyncAuthority } from '../../sync/product-authority-react';
import { useProductSyncRuntime } from '../../sync/product-runtime-react';
import '../../../styles/feedback.css';

type Phase = 'editing' | 'sending' | 'sent' | 'failed';

/**
 * Feedback the author sends on purpose: their message, a reply-to address
 * (the account's by default) and the sanitized diagnostic summary unless they
 * detach it. As a crash follow-up it carries the report it explains. Without
 * the Hosted service, or when sending fails, the same message goes to mail.
 */
export function FeedbackDialog({ followUp, onClose }: { followUp: CrashFollowUp | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const accountEmail = useAuthStore((s) => s.hostedUser?.email ?? '');
  const authority = useProductSyncAuthority();
  const sync = useProductSyncRuntime();
  const update = useSyncExternalStore(UpdateService.subscribe, UpdateService.getState);
  // Taken once as the dialog opens, so the preview is exactly what is sent.
  const [summary] = useState(() =>
    createSanitizedDiagnosticSummary({ runtime: getPlatformRuntime(), authority, sync, update }));
  const [delivery] = useState(feedbackDelivery);
  const [message, setMessage] = useState('');
  const [contactEmail, setContactEmail] = useState(accountEmail);
  const [attach, setAttach] = useState(true);
  const [preview, setPreview] = useState(false);
  const [phase, setPhase] = useState<Phase>('editing');

  const locale = i18n.resolvedLanguage ?? i18n.language;
  const draft: FeedbackDraft = { message, contactEmail, diagnostics: attach ? summary : null, followUp, locale };
  const problems = feedbackProblems(draft);
  const invalidEmail = problems.includes('invalid-email');
  const locked = phase === 'sending' || phase === 'sent';
  const byEmail = delivery === 'email' || phase === 'failed';
  const canSend = problems.length === 0 && !locked;
  const title = followUp ? t('feedback.crash.title') : t('feedback.title');

  // Sending or ignoring a follow-up retires its notification; closing keeps it.
  const retire = () => {
    if (followUp) useNotificationStore.getState().remove(crashFollowUpNotificationId(followUp));
  };
  const ignore = () => {
    retire();
    onClose();
  };
  const submit = async () => {
    if (!canSend) return;
    if (byEmail) {
      const subject = followUp ? t('feedback.crash.emailSubject') : t('feedback.emailSubject');
      void platform.material.openExternal(feedbackEmailUrl(draft, subject));
      retire();
      onClose();
      return;
    }
    setPhase('sending');
    if (await sendFeedback(draft)) {
      setPhase('sent');
      retire();
    } else {
      setPhase('failed');
    }
  };
  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  };

  const occurredAt = followUp ? new Date(followUp.occurredAt) : null;
  const kicker = occurredAt && !Number.isNaN(occurredAt.getTime())
    ? occurredAt.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : undefined;

  return (
    <ModalRoot onClose={onClose} ariaLabel={title} className="feedback-dialog-root"
      closeOnBackdrop={!message.trim() && phase !== 'sending'} dismissOnEscape={phase !== 'sending'}>
      <ModalCard width={520}>
        <ModalHeader kicker={kicker} title={title} onClose={onClose} closeLabel={t('feedback.close')} />
        <ModalBody className="feedback-dialog">
          <label className="ui-field ui-field--area glass glass--rest glass--field feedback-dialog__message">
            <textarea
              autoFocus
              value={message}
              maxLength={FEEDBACK_MESSAGE_MAX}
              aria-label={title}
              placeholder={followUp ? t('feedback.crash.placeholder') : t('feedback.placeholder')}
              disabled={locked}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={onMessageKeyDown}
            />
          </label>
          <section className="dialog-section">
            <span className="dialog-section__label">{t('feedback.contact')}</span>
            <label className={`ui-field glass glass--rest glass--field feedback-dialog__field${invalidEmail ? ' is-invalid' : ''}`}>
              <input
                type="email"
                value={contactEmail}
                autoComplete="email"
                spellCheck={false}
                aria-label={t('feedback.contact')}
                aria-invalid={invalidEmail || undefined}
                placeholder={t('feedback.contactPlaceholder')}
                disabled={locked}
                onChange={(event) => setContactEmail(event.target.value)}
              />
            </label>
          </section>
          <div className="feedback-dialog__attach">
            <label className="feedback-dialog__switch">
              <Switch size="sm" checked={attach} disabled={locked} onCheckedChange={setAttach}
                aria-label={t('feedback.attachDiagnostics')} />
              <span>{t('feedback.attachDiagnostics')}</span>
            </label>
            <Button variant="ghost" size="sm" disabled={!attach || locked} aria-expanded={attach && preview}
              onClick={() => setPreview(!preview)}>
              {attach && preview ? t('feedback.hidePreview') : t('feedback.preview')}
            </Button>
          </div>
          {attach && preview && (
            <pre className="glass glass--rest glass--still feedback-dialog__preview">{summary}</pre>
          )}
        </ModalBody>
        <ModalActions>
          <span className="feedback-dialog__result" role={phase === 'failed' ? 'alert' : 'status'}>
            {phase === 'sent' && <><BrushIcon name="status-done" size={14} />{t('feedback.sent')}</>}
            {phase === 'failed' && <><BrushIcon name="status-warning" size={14} />{t('feedback.failed')}</>}
          </span>
          {phase === 'sent' ? (
            <Button onClick={onClose}>{t('feedback.close')}</Button>
          ) : (
            <>
              <Button onClick={followUp ? ignore : onClose} disabled={phase === 'sending'}>
                {followUp ? t('feedback.crash.ignore') : t('feedback.cancel')}
              </Button>
              <Button variant="primary" disabled={!canSend} onClick={() => void submit()}>
                {phase === 'sending' && <BrushIcon name="loader" size={14} className="ui-spin" />}
                {byEmail ? t('feedback.sendByEmail') : phase === 'sending' ? t('feedback.sending') : t('feedback.send')}
                {byEmail && <BrushIcon name="arrow-out" size={12} />}
              </Button>
            </>
          )}
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
