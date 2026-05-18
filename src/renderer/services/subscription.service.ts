/**
 * Subscription service — talks to /api/subscription. All Stripe-specific
 * logic stays on the server (we never expose price IDs or secret keys to
 * the renderer).
 *
 * Flow:
 *   1. Settings page calls `getStatus()` → renders the cached plan card.
 *   2. Click "升级" → `createCheckoutSession(plan)` → open URL in system
 *      browser via Electron `shell.openExternal`.
 *   3. Stripe redirects user back; the webhook updates the cache.
 *   4. Settings page polls `getStatus()` on focus to pick up the change.
 *
 * If `stripeConfigured` is false, the page should show a "未配置" badge
 * and disable the upgrade buttons.
 */
import { apiClient } from '../lib/axios-config';

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
    if (data.url) window.open(data.url, '_blank');
  },

  async openCustomerPortal(): Promise<void> {
    const { data } = await apiClient.post<{ url: string }>('/api/subscription/portal', {
      returnUrl: 'drifting://settings/subscription',
    });
    if (data.url) window.open(data.url, '_blank');
  },

  async listInvoices(): Promise<{ invoices: Invoice[]; stripeConfigured: boolean }> {
    const { data } = await apiClient.get<{ invoices: Invoice[]; stripeConfigured: boolean }>(
      '/api/subscription/invoices',
    );
    return data;
  },
};
