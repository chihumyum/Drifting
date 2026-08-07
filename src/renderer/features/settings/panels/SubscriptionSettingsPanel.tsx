import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../../store/auth';
import { subscriptionService, type Invoice, type SubscriptionStatus } from '../../../services/subscription.service';
import { refreshFeatureAccess } from '../../../lib/feature-access';
import { isByokOnly } from '../../../lib/config';
import { platform } from '../../../platform';
import {
  SettingsPanelHeader,
  SettingsRow,
  SettingsSectionHeader,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';

// 订阅 — 仅展示当前计划与「升级 / 降级」「浏览发票」二级页面入口
type SubView = 'overview' | 'plans' | 'invoices';

const PLAN_LABEL_KEY: Record<string, string> = {
  free: 'settings.subscription.plans.free_label',
  pro: 'settings.subscription.plans.pro_label',
  studio: 'settings.subscription.plans.studio_label',
};

const PLAN_PRICE: Record<string, string> = {
  free: '¥0',
  pro: '¥58',
  studio: '¥168',
};

export function SubscriptionPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id);
  const [view, setView] = useState<SubView>('overview');
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [switching, setSwitching] = useState<'free' | 'pro' | 'studio' | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const s = await subscriptionService.getStatus();
      setStatus(s);
      // Keep the global feature-access cache in lockstep so the trash gate
      // (and rail badge) react immediately to a plan change made from this
      // panel.
      if (userId) await refreshFeatureAccess(userId);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // DEV plan switch — bypasses Stripe. Removes when payment ships.
  const switchPlan = useCallback(
    async (plan: 'free' | 'pro' | 'studio') => {
      setSwitching(plan);
      try {
        await subscriptionService.setPlan(plan);
        await reload();
      } catch (err) {
        console.error('[set-plan] failed', err);
      } finally {
        setSwitching(null);
      }
    },
    [reload],
  );

  useEffect(() => {
    // Mount fetch: reload() flips setLoading(true) then fetches. This is the
    // legitimate "load on mount" pattern the rule can't infer through the
    // async callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  // Refresh on window focus — covers the "redirected back from Stripe
  // Checkout in the system browser" case.
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  useEffect(() => {
    if (view !== 'invoices') return;
    void subscriptionService.listInvoices().then((d) => setInvoices(d.invoices));
  }, [view]);

  const configured = !!status?.stripeConfigured;
  const plan = status?.plan ?? 'free';
  const planName = PLAN_LABEL_KEY[plan] ? t(PLAN_LABEL_KEY[plan]) : plan;
  const renewLine = status?.currentPeriodEnd
    ? `${t('settings.subscription.renew_line', {
        date: new Date(status.currentPeriodEnd).toLocaleDateString(),
      })}${status.cancelAtPeriodEnd ? t('settings.subscription.cancel_at_period_end') : ''}`
    : t('settings.subscription.no_paid_plan');

  if (view === 'plans') {
    return (
      <section className="set-panel" ref={registerRef} id="subscription">
        <button
          className="set-head__back"
          style={{ marginBottom: 12 }}
          onClick={() => setView('overview')}
        >
          <span>←</span>
          <span>{t('settings.subscription.back')}</span>
        </button>
        <SettingsPanelHeader
          kicker={t('settings.subscription.plans_kicker')}
          title={t('settings.subscription.plans_title')}
        />
        <div className="set-plans">
          <PlanCard
            kicker={t('settings.subscription.free')}
            name={t('settings.subscription.plans.free_name')}
            price="¥0"
            features={[
              t('settings.subscription.plans.free_feature_1'),
              t('settings.subscription.plans.free_feature_2'),
              t('settings.subscription.plans.free_feature_4'),
            ]}
            ctaLabel={
              plan === 'free'
                ? t('settings.subscription.current_plan')
                : switching === 'free'
                  ? t('settings.subscription.switching')
                  : t('settings.subscription.downgrade')
            }
            current={plan === 'free'}
            onClick={plan === 'free' ? undefined : () => switchPlan('free')}
          />
          <PlanCard
            kicker={
              plan === 'pro'
                ? t('settings.subscription.current_kicker')
                : t('settings.subscription.recommended')
            }
            name="Drifting Pro"
            price="¥58"
            features={[
              t('settings.subscription.plans.pro_feature_1'),
              t('settings.subscription.plans.pro_feature_3'),
              t('settings.subscription.plans.pro_feature_4'),
              t('settings.subscription.plans.pro_feature_5'),
            ]}
            ctaLabel={
              plan === 'pro'
                ? t('settings.subscription.current_plan')
                : switching === 'pro'
                  ? t('settings.subscription.switching')
                  : t('settings.subscription.upgrade')
            }
            current={plan === 'pro'}
            primary={plan !== 'pro'}
            onClick={plan === 'pro' ? undefined : () => switchPlan('pro')}
          />
          <PlanCard
            kicker={
              plan === 'studio'
                ? t('settings.subscription.current_kicker')
                : t('settings.subscription.professional')
            }
            name="Studio"
            price="¥168"
            features={[
              t('settings.subscription.plans.studio_feature_2'),
              t('settings.subscription.plans.studio_feature_3'),
              t('settings.subscription.plans.studio_feature_4'),
            ]}
            ctaLabel={
              plan === 'studio'
                ? t('settings.subscription.current_plan')
                : switching === 'studio'
                  ? t('settings.subscription.switching')
                  : t('settings.subscription.upgrade')
            }
            current={plan === 'studio'}
            primary={plan !== 'studio'}
            onClick={plan === 'studio' ? undefined : () => switchPlan('studio')}
          />
        </div>
        <div
          style={{
            marginTop: 18,
            padding: '10px 14px',
            background: 'hsl(var(--paper-deep))',
            border: '1px dashed hsl(var(--rule))',
            borderRadius: 5,
            fontSize: 11,
            color: 'hsl(var(--ink-4))',
            lineHeight: 1.6,
          }}
        >
          <b>DEV</b> · {t('settings.subscription.dev_notice')}
        </div>
      </section>
    );
  }

  if (view === 'invoices') {
    return (
      <section className="set-panel" ref={registerRef} id="subscription">
        <button
          className="set-head__back"
          style={{ marginBottom: 12 }}
          onClick={() => setView('overview')}
        >
          <span>←</span>
          <span>{t('settings.subscription.back')}</span>
        </button>
        <SettingsPanelHeader
          kicker={t('settings.subscription.invoices_kicker')}
          title={t('settings.subscription.invoices_title')}
        />
        <div className="set-sec">
          <SettingsSectionHeader title={t('settings.subscription.recent')} />
          {!configured && (
            <div className="set-row__desc">{t('settings.subscription.stripe_unconfigured')}</div>
          )}
          {configured && invoices === null && (
            <div className="set-row__desc">{t('settings.subscription.loading')}</div>
          )}
          {configured && invoices && invoices.length === 0 && (
            <div className="set-row__desc">{t('settings.subscription.no_invoices')}</div>
          )}
          {configured &&
            invoices?.map((inv) => (
              <SettingsRow
                key={inv.id}
                label={
                  <span className="set-italic">
                    {new Date(inv.createdAt).toLocaleDateString()} · {planName}
                  </span>
                }
                desc={
                  <span className="set-mono">
                    {(inv.currency ?? '').toUpperCase()} {(inv.amount / 100).toFixed(2)} ·{' '}
                    {inv.status}
                    {inv.number ? ` · #${inv.number}` : ''}
                  </span>
                }
                control={
                  inv.pdfUrl ? (
                    <button
                      className="set-btn"
                      onClick={() => {
                        if (inv.pdfUrl) void platform.material.openExternal(inv.pdfUrl);
                      }}
                    >
                      {t('settings.subscription.download_pdf')}
                    </button>
                  ) : null
                }
              />
            ))}
        </div>
      </section>
    );
  }

  return (
    <section className="set-panel" ref={registerRef} id="subscription">
      <SettingsPanelHeader
        kicker={t('settings.subscription.kicker')}
        title={t('settings.subscription.title')}
        sub={
          loading ? (
            t('settings.subscription.loading')
          ) : configured ? (
            <>
              {t('settings.subscription.current_plan_inline')}{' '}
              <em className="set-italic">{planName}</em> · {renewLine}
            </>
          ) : (
            <>{t('settings.subscription.free_plan_inline')}</>
          )
        }
      />

      <div className="set-plan-current">
        <div className="set-plan-current__body">
          <div className="set-plan-current__kicker">
            {plan === 'free'
              ? t('settings.subscription.free')
              : t('settings.subscription.current_kicker')}
          </div>
          <div className="set-plan-current__name">{planName}</div>
          <div className="set-plan-current__meta">
            {PLAN_PRICE[plan] ?? '—'} {t('settings.subscription.per_month')} · {renewLine}
          </div>
        </div>
        <div className="set-plan-current__cta">
          <button
            className="set-btn"
            onClick={isByokOnly() ? undefined : () => setView('plans')}
            disabled={isByokOnly()}
            title={isByokOnly() ? t('settings.subscription.hosted_coming_soon') : undefined}
          >
            {t('settings.subscription.plans_kicker')}
          </button>
          <button className="set-btn" onClick={() => setView('invoices')}>
            {t('settings.subscription.view_invoices')}
          </button>
        </div>
      </div>

      {configured && plan !== 'free' && (
        <div className="set-sec" style={{ marginTop: 28 }}>
          <SettingsSectionHeader title={t('settings.subscription.payment_cancel')} hint="VIA STRIPE PORTAL" />
          <SettingsRow
            label={t('settings.subscription.manage_payment')}
            desc={t('settings.subscription.manage_payment_desc')}
            control={
              <button className="set-btn" onClick={() => subscriptionService.openCustomerPortal()}>
                {t('settings.subscription.open_portal')}
              </button>
            }
          />
        </div>
      )}
    </section>
  );
}

function PlanCard({
  kicker,
  name,
  price,
  features,
  ctaLabel,
  current,
  primary,
  onClick,
}: {
  kicker: string;
  name: string;
  price: string;
  features: string[];
  ctaLabel: string;
  current?: boolean;
  primary?: boolean;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={'set-plan' + (current ? ' set-plan--current' : '')}>
      <div className="set-plan__kicker">{kicker}</div>
      <div className="set-plan__name">{name}</div>
      <div className="set-plan__price">
        {price}
        <sub>{t('settings.subscription.month_suffix')}</sub>
      </div>
      <div className="set-plan__rule" />
      {features.map((f) => (
        <div className="set-plan__feat" key={f}>
          {f}
        </div>
      ))}
      <div className="set-plan__cta">
        <button
          className={'set-btn' + (primary ? ' set-btn--primary' : '')}
          onClick={onClick}
          disabled={!onClick}
        >
          {ctaLabel}
        </button>
      </div>
    </div>
  );
}
