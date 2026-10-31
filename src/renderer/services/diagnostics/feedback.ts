import { APP_CONFIG, canUseHostedService } from '../../lib/config';
import { getSessionToken } from '../../lib/session-token';
import { getPlatformRuntime } from '../../platform/runtime';
import { diagnosticsInstallationId, type CrashFollowUp } from './crash-reporter';
import { reportToken } from './crash-sanitize';

/**
 * Feedback the author writes and sends on purpose (see the Hosted service's
 * docs/diagnostics-v1.md). It carries their own words, an optional reply-to
 * address and, when they leave it attached, the sanitized diagnostic summary;
 * never manuscript text, the database or credentials. It does not depend on
 * Settings → Privacy → Send fault diagnostics automatically: that switch only
 * governs what is sent without asking. Builds without a Hosted service, and
 * moments without a network, hand the same message to the mail client.
 */
export const FEEDBACK_MESSAGE_MAX = 5000;

export type FeedbackKind = 'feedback' | 'crash-follow-up';
export type FeedbackProblem = 'empty-message' | 'message-too-long' | 'invalid-email';

export interface FeedbackDraft {
  message: string;
  contactEmail: string;
  /** The sanitized summary text (`createSanitizedDiagnosticSummary`), or null when detached. */
  diagnostics: string | null;
  /** The crash this explains, for a follow-up. */
  followUp: CrashFollowUp | null;
  locale: string;
}

export interface FeedbackPayload {
  format: 'drifting.feedback';
  formatVersion: 1;
  kind: FeedbackKind;
  message: string;
  contactEmail: string | null;
  diagnostics: Record<string, unknown> | null;
  related: {
    reportId: string | null;
    kind: CrashFollowUp['kind'];
    fingerprint: string;
    occurredAt: string;
  } | null;
  appVersion: string;
  platform: string;
  installationId: string;
  locale: string;
  submittedAt: string;
}

const EMAIL = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[A-Za-z]{2,}$/;
// Mail clients are reliable up to a few thousand characters of URL.
const MAX_MAIL_BODY = 6000;

export function feedbackProblems(draft: Pick<FeedbackDraft, 'message' | 'contactEmail'>): FeedbackProblem[] {
  const problems: FeedbackProblem[] = [];
  const message = draft.message.trim();
  if (!message) problems.push('empty-message');
  if (message.length > FEEDBACK_MESSAGE_MAX) problems.push('message-too-long');
  const email = draft.contactEmail.trim();
  if (email && (email.length > 254 || !EMAIL.test(email))) problems.push('invalid-email');
  return problems;
}

/** Where a submission goes right now: the Hosted service, or the mail client. */
export function feedbackDelivery(): 'hosted' | 'email' {
  if (APP_CONFIG.LOCAL_ONLY_MODE || !canUseHostedService()) return 'email';
  if (import.meta.env.DEV && import.meta.env.VITE_DRIFTING_CRASH_REPORTS_IN_DEV !== '1') return 'email';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'email';
  return 'hosted';
}

function appIdentity() {
  const runtime = getPlatformRuntime();
  return {
    appVersion: reportToken(runtime.appInfo?.version ?? 'unknown'),
    platform: reportToken(runtime.appInfo?.platform ?? runtime.nativePlatform ?? 'unknown', 32),
  };
}

function parsedDiagnostics(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      && (value as { format?: unknown }).format === 'drifting.sanitized-diagnostics'
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function buildFeedbackPayload(draft: FeedbackDraft, now = new Date()): FeedbackPayload {
  const email = draft.contactEmail.trim();
  return {
    format: 'drifting.feedback',
    formatVersion: 1,
    kind: draft.followUp ? 'crash-follow-up' : 'feedback',
    message: draft.message.trim().slice(0, FEEDBACK_MESSAGE_MAX),
    contactEmail: email || null,
    diagnostics: parsedDiagnostics(draft.diagnostics),
    related: draft.followUp
      ? {
          reportId: draft.followUp.reportId,
          kind: draft.followUp.kind,
          fingerprint: draft.followUp.fingerprint,
          occurredAt: draft.followUp.occurredAt,
        }
      : null,
    ...appIdentity(),
    installationId: diagnosticsInstallationId(),
    locale: reportToken(draft.locale, 16),
    submittedAt: now.toISOString(),
  };
}

/** Send to the Hosted service; false means the author should fall back to mail. */
export async function sendFeedback(draft: FeedbackDraft): Promise<boolean> {
  if (feedbackDelivery() !== 'hosted') return false;
  try {
    const token = getSessionToken();
    const response = await fetch(
      `${APP_CONFIG.API_BASE_URL.replace(/\/$/, '')}/api/diagnostics/v1/feedback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(buildFeedbackPayload(draft)),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** A `mailto:` URL carrying the same message, for builds and moments without the service. */
export function feedbackEmailUrl(draft: FeedbackDraft, subject: string): string {
  const { appVersion, platform } = appIdentity();
  const footer = [
    `Drifting ${appVersion} · ${platform}`,
    ...(draft.followUp ? [`${draft.followUp.fingerprint} · ${draft.followUp.occurredAt}`] : []),
  ].join('\n');
  const head = `${draft.message.trim()}\n\n—\n${footer}`;
  const withDiagnostics = draft.diagnostics ? `${head}\n\n${draft.diagnostics.trim()}` : head;
  const body = withDiagnostics.length <= MAX_MAIL_BODY ? withDiagnostics : head.slice(0, MAX_MAIL_BODY);
  return `mailto:${APP_CONFIG.SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
