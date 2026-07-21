/**
 * Subscription service — talks to /api/subscription. All Stripe-specific
 * logic stays on the server (we never expose price IDs or secret keys to
 * the renderer).
 *
 * Flow:
 *   1. Settings page calls `getStatus()` → renders the cached plan card.
 *   2. Click "升级" → `createCheckoutSession(plan)` → open URL in the system
 *      browser through the native platform adapter.
 *   3. Stripe redirects user back; the webhook updates the cache.
 *   4. Settings page polls `getStatus()` on focus to pick up the change.
 *
 * If `stripeConfigured` is false, the page should show a "未配置" badge
 * and disable the upgrade buttons.
 */
import { apiClient } from '../lib/axios-config';
import { platform } from '../platform';

export interface SubscriptionStatus {
  status: string | null; // 'active' | 'past_due' | 'canceled' | 'trialing' | null
  plan: string | null; // 'free' | 'pro' | 'studio'
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeConfigured: boolean;
}

export interface Invoice {
  id: string;
  createdAt: string;
  amount: number;
  currency: string;
  status: string;
  pdfUrl: string | null;
  number: string | null;
}

export const subscriptionService = {
  async getStatus(): Promise<SubscriptionStatus> {
    const { data } = await apiClient.get<SubscriptionStatus>('/api/subscription/status');
    return data;
  },

  async openCheckout(plan: 'pro' | 'studio'): Promise<void> {
    const { data } = await apiClient.post<{ url: string }>('/api/subscription/checkout', {
      plan,
      returnUrl: 'drifting://settings/subscription',
    });
    if (data.url) {
      const result = await platform.material.openExternal(data.url);
      if (!result.ok) throw new Error(result.error);
    }
  },

  async openCustomerPortal(): Promise<void> {
    const { data } = await apiClient.post<{ url: string }>('/api/subscription/portal', {
      returnUrl: 'drifting://settings/subscription',
    });
    if (data.url) {
      const result = await platform.material.openExternal(data.url);
      if (!result.ok) throw new Error(result.error);
    }
  },

  async listInvoices(): Promise<{ invoices: Invoice[]; stripeConfigured: boolean }> {
    const { data } = await apiClient.get<{ invoices: Invoice[]; stripeConfigured: boolean }>(
      '/api/subscription/invoices',
    );
    return data;
  },

  // DEV / prototype path — bypasses Stripe and stamps the subscription row
  // directly. The real upgrade flow goes through openCheckout. Once payment
  // is wired up this should be removed (or hidden behind an env flag) so
  // users can't grant themselves Pro for free.
  async setPlan(plan: 'free' | 'pro' | 'studio'): Promise<void> {
    await apiClient.post('/api/subscription/set-plan', { plan });
  },
};
