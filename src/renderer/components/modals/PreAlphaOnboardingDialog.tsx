import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import loglevel from 'loglevel';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { hostedAccountSettingsEnabled } from '../../features/settings/hosted-settings-policy';
import { AuthFlow } from '../../features/auth/AuthFlow';
import { cancelNativeOAuth, startNativeOAuth } from '../../features/auth/native-oauth';
import { GoogleIcon } from '../auth/OAuthIcon';
import { FirstRunArrival } from '../first-run/first-run-shelf';
import { firstRunStep, type FirstRunStep } from '../first-run/first-run-steps';
import { OAUTH_PROVIDER_CONFIG, useOAuthProviders } from '../../lib/oauth-providers';
import { FIRST_RUN_LEAVE_MS, FIRST_RUN_TITLE_MS, PAGE_BLEND_MS } from '../../lib/motion';
import { isAppClosedForPublic } from '../../utils/appAccess';
import { useAuthStore } from '../../store/auth';
import { requestConfirmation } from '../../store/confirmation-store';
import { platform } from '../../platform';
import type { MarkdownFolderSettings } from '../../platform/contracts';
import { getPlatformRuntime } from '../../platform/runtime';
import { useCharSeaEnabled, useCharSeaHold, useCharSeaShape } from '../char-sea/useCharSea';
import { Button } from '../ui/Button';
import { GlassSelect } from '../ui/GlassSelect';
import { UI_LOCALE_OPTIONS } from '../../lib/i18n';
import { useSettingsStore } from '../../store/settings-store';
import { ModalActions, ModalBody, ModalHeader } from '../ui/Modal';
import { alphaGuideStorageKey } from '../../lib/alpha-guide-key';

// v2 (2026-11-06): the folder has no default location any more, so every
// device is asked again; one already writing somewhere sees it as chosen.
const FOLDER_GUIDE_KEY = 'drifting.markdown-folder-guide.v2';
const log = loglevel.getLogger('FirstRun');

function usePreAlphaGuide() {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const storageKey = userId ? alphaGuideStorageKey(userId) : null;
  const open = Boolean(
    isAuthenticated &&
    storageKey &&
    dismissedKey !== storageKey &&
    localStorage.getItem(storageKey) !== 'seen',
  );
  const dismiss = useCallback(() => {
    if (!storageKey) return;
    localStorage.setItem(storageKey, 'seen');
    setDismissedKey(storageKey);
  }, [storageKey]);
  return { open, dismiss };
}

/** The desktop asks once per device where projects' Markdown folders go. */
function useMarkdownFolderGuide() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [dismissed, setDismissed] = useState(false);
  const open = Boolean(
    isAuthenticated &&
    !dismissed &&
    getPlatformRuntime().target === 'desktop' &&
    localStorage.getItem(FOLDER_GUIDE_KEY) !== 'seen',
  );
  const dismiss = useCallback(() => {
    localStorage.setItem(FOLDER_GUIDE_KEY, 'seen');
    setDismissed(true);
  }, []);
  return { open, dismiss };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Where every project's Markdown folder goes. There is no default: the author
 * picks a folder before going on (one already chosen on this device counts).
 * Turning the folder off is offered too, in the danger ink and behind a
 * confirmation, since external editors and Agents then lose the book.
 */
function MarkdownFolderGuide({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const [folder, setFolder] = useState<MarkdownFolderSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    platform.markdownProjection.folder().then(
      (next) => { if (live) setFolder(next); },
      (failure) => { if (live) setError(errorText(failure)); },
    );
    return () => { live = false; };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const choose = () => run(async () => {
    const root = await platform.markdownProjection.pickOutputRoot(t('markdownFolderGuide.choose'));
    if (root !== null) setFolder(await platform.markdownProjection.setDefaultRoot(root));
  });
  const turnOff = () => run(async () => {
    const confirmed = await requestConfirmation(t('settings.sync.projection.offWarning'), {
      title: t('settings.sync.projection.offTitle'),
      confirmLabel: t('settings.sync.projection.turnOff'),
      destructive: true,
    });
    if (!confirmed) return;
    await platform.markdownProjection.setEnabled(false);
    onDone();
  });
  const chosen = folder !== null && folder.directory !== null;

  return (
    <>
      <ModalHeader title={t('markdownFolderGuide.title')} />
      <ModalBody>
        <p className="pre-alpha-guide-modal__text">{t('markdownFolderGuide.intro')}</p>
        {chosen && (
          <div className="markdown-folder-guide__location">
            <div className="markdown-folder-guide__label">{t('markdownFolderGuide.chosen')}</div>
            <code className="markdown-folder-guide__path">{folder.directory}</code>
          </div>
        )}
        {error && <p role="alert" className="markdown-folder-guide__error">{error}</p>}
      </ModalBody>
      <ModalActions>
        <Button
          className="markdown-folder-guide__off"
          variant="danger"
          onClick={() => void turnOff()}
          disabled={busy}
        >
          {t('settings.sync.projection.turnOff')}
        </Button>
        <Button
          variant={chosen ? 'default' : 'primary'}
          onClick={() => void choose()}
          disabled={busy}
          autoFocus={!chosen}
        >
          {t('markdownFolderGuide.choose')}
        </Button>
        {chosen && (
          <Button variant="primary" onClick={onDone} disabled={busy} autoFocus>
            {t('markdownFolderGuide.continue')}
          </Button>
        )}
      </ModalActions>
    </>
  );
}

const reducedMotion = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

/**
 * The welcome: how to go on, and nothing else. Google shows when the service
 * offers it; signing in with it moves straight to the sign-in step, which
 * waits for the browser. Hosted builds say there that crash reports are sent.
 */
function FirstRunWelcome({
  onGoogle,
  onEmail,
  onLocal,
}: {
  onGoogle(): void;
  onEmail(): void;
  onLocal(): void;
}) {
  const { t } = useTranslation();
  const providers = useOAuthProviders();
  // Social sign-in also creates accounts, so it is hidden while sign-up is closed.
  const google = !isAppClosedForPublic && providers.includes('google');
  return (
    <div className="first-run-welcome">
      {google && (
        <Button className="first-run-welcome__way" onClick={onGoogle}>
          <GoogleIcon width={14} height={14} aria-hidden />
          {t('auth.social.continueWith', { provider: OAUTH_PROVIDER_CONFIG.google.name })}
        </Button>
      )}
      <Button className="first-run-welcome__way" onClick={onEmail}>
        {t('firstRun.email')}
      </Button>
      <Button className="first-run-welcome__local" variant="ghost" onClick={onLocal}>
        {t('firstRun.local')}
      </Button>
      <p className="first-run-welcome__note">{t('preAlphaGuide.crashReports')}</p>
    </div>
  );
}

/**
 * The card on the window: a resting glass line the sea draws, set down with no
 * line at first so the water shows its rim. Its steps are panes in the same
 * place; a new one dissolves in over the last while the line follows the new
 * size (the page-turn timing). Leaving, it fades and its line eases out.
 */
function FirstRunCard({
  step,
  leaving,
  label,
  children,
}: {
  step: FirstRunStep;
  leaving: boolean;
  label: string;
  children: (step: FirstRunStep) => ReactNode;
}) {
  const { attach: cardRef, drawn: onSea } = useCharSeaShape<HTMLElement>({
    rest: leaving ? 0 : 0.85,
    radius: 2,
    hover: false,
    arrive: true,
  });
  const [panes, setPanes] = useState<{ front: FirstRunStep; behind: FirstRunStep | null }>({
    front: step,
    behind: null,
  });
  if (panes.front !== step) setPanes({ front: step, behind: panes.front });
  useEffect(() => {
    if (!panes.behind) return undefined;
    const timer = window.setTimeout(() => setPanes((now) => ({ ...now, behind: null })), PAGE_BLEND_MS);
    return () => window.clearTimeout(timer);
  }, [panes]);

  // The card takes the size of the pane in front, and follows it as it changes.
  const pane = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element) return undefined;
    const measure = () => setSize({ width: element.offsetWidth, height: element.offsetHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [panes.front]);

  const shown = panes.behind ? [panes.behind, panes.front] : [panes.front];
  return (
    <section
      ref={cardRef}
      className={`first-run-gate__card glass glass--rest glass--still${onSea ? ' first-run-gate__card--sea' : ''}${leaving ? ' first-run-gate__card--leaving' : ''}`}
      style={size ? { width: size.width, height: size.height } : undefined}
      aria-label={label}
    >
      {shown.map((name) => (
        <div
          key={name}
          ref={name === panes.front ? pane : undefined}
          className={`first-run-gate__pane first-run-gate__pane--${name}${name === panes.front ? '' : ' first-run-gate__pane--leaving'}`}
          aria-hidden={name === panes.front ? undefined : true}
          inert={name === panes.front ? undefined : true}
        >
          {children(name)}
        </div>
      ))}
    </section>
  );
}

/**
 * The interface language, out of the way in the window's corner: the card,
 * the sea's passage and everything after follow it at once.
 */
function FirstRunLanguage({ leaving }: { leaving: boolean }) {
  const { t } = useTranslation();
  const uiLocale = useSettingsStore((state) => state.uiLocale);
  const setUiLocale = useSettingsStore((state) => state.setUiLocale);
  return (
    <div className={`first-run-gate__language${leaving ? ' first-run-gate__language--leaving' : ''}`}>
      <GlassSelect
        value={uiLocale}
        onChange={setUiLocale}
        ariaLabel={t('userMenu.language')}
        options={UI_LOCALE_OPTIONS.map((locale) => ({ value: locale.code, label: locale.native }))}
      />
    </div>
  );
}

type GateStage = 'title' | 'card' | 'leaving' | 'done';

/**
 * Desktop first run, before the shelf mounts (docs/design-system/components.md,
 * "全屏加载与字海"). On the sea of characters the app's name rises first
 * (FIRST_RUN_TITLE_MS), then lets go, and its ring leaves the card behind; the
 * rain falls round the card, the hand still stirs the water, and the sea draws
 * the card's resting glass and shows through it at 12%. Signing in happens in
 * the same card, so the shelf first opens with the account's cloud projects
 * already restored; then, once per device, the same card asks where projects'
 * Markdown folders go. The interface language waits in the window's corner
 * the whole way. When nothing is left the card fades as the shelf comes up
 * under it as a whole, and what lies on the shelf is set down on the sea.
 */
export function PreAlphaFirstRunGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hosted = hostedAccountSettingsEnabled();
  const session = useAuthStore((state) => state.session);
  const { open: guideOpen, dismiss } = usePreAlphaGuide();
  const folderGuide = useMarkdownFolderGuide();
  const onSea = useCharSeaEnabled();
  const [signingIn, setSigningIn] = useState(false);
  const open = guideOpen || folderGuide.open;
  const step = firstRunStep({ guideOpen, folderOpen: folderGuide.open, hosted, signingIn });

  const [stage, setStage] = useState<GateStage>(() =>
    !open ? 'done' : guideOpen && onSea && !reducedMotion() ? 'title' : 'card');
  // Whether this mount came through the card, so the shelf keeps one place in the tree.
  const [throughCard, setThroughCard] = useState(open);
  if (open && (stage === 'done' || stage === 'leaving')) setStage('card');
  if (open && !throughCard) setThroughCard(true);
  if (!open && (stage === 'title' || stage === 'card')) setStage('leaving');
  // The last step stays on the card while it leaves; with none yet there is no card.
  const [shownStep, setShownStep] = useState<FirstRunStep | null>(step);
  if (step && step !== shownStep) setShownStep(step);

  useCharSeaHold('title', stage === 'title' && onSea);
  useCharSeaHold('rain', (stage === 'title' || stage === 'card') && onSea);

  useEffect(() => {
    if (stage === 'title') {
      const timer = window.setTimeout(() => setStage('card'), FIRST_RUN_TITLE_MS);
      return () => window.clearTimeout(timer);
    }
    if (stage === 'leaving') {
      const timer = window.setTimeout(() => setStage('done'), FIRST_RUN_LEAVE_MS);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [stage]);

  // Without an account to choose, the welcome has one way on: it is taken.
  useEffect(() => {
    if (stage !== 'title' && guideOpen && !hosted) dismiss();
  }, [stage, guideOpen, hosted, dismiss]);

  if (stage === 'done' && !throughCard) return <>{children}</>;

  const toAccount = (signIn: () => void) => {
    if (!hosted) return;
    if (!session) {
      signIn();
      setSigningIn(true);
      return;
    }
    dismiss();
    navigate('/settings?section=account', { state: { from: '/' } });
  };
  const renderStep = (name: FirstRunStep) =>
    name === 'folder' ? (
      <MarkdownFolderGuide onDone={folderGuide.dismiss} />
    ) : name === 'account' ? (
      <AuthFlow
        initialMode="signin"
        onBack={() => {
          cancelNativeOAuth();
          setSigningIn(false);
        }}
        onComplete={dismiss}
      />
    ) : (
      <FirstRunWelcome
        onGoogle={() =>
          toAccount(() => {
            void startNativeOAuth('google').catch((error) => log.warn('[first-run] Google sign-in did not open', error));
          })}
        onEmail={() => toAccount(() => undefined)}
        onLocal={dismiss}
      />
    );

  const shelf = stage === 'leaving' || stage === 'done' ? (
    <div key="shelf" className="first-run-arrival">
      <FirstRunArrival.Provider value={stage === 'leaving'}>{children}</FirstRunArrival.Provider>
    </div>
  ) : null;
  return (
    <>
      {shelf}
      {stage !== 'done' && (
        <div
          key="gate"
          className={`first-run-gate${onSea ? ' first-run-gate--sea' : ''}${stage === 'leaving' ? ' first-run-gate--leaving' : ''}`}
        >
          {getPlatformRuntime().desktopWindowControls && (
            <div className="first-run-gate__drag" data-tauri-drag-region aria-hidden />
          )}
          {stage !== 'title' && shownStep && (
            <FirstRunCard
              step={shownStep}
              leaving={stage === 'leaving'}
              label={t(shownStep === 'folder' ? 'markdownFolderGuide.title' : 'preAlphaGuide.title')}
            >
              {renderStep}
            </FirstRunCard>
          )}
          {stage !== 'title' && shownStep && <FirstRunLanguage leaving={stage === 'leaving'} />}
        </div>
      )}
    </>
  );
}
