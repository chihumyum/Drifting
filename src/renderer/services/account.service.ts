/**
 * Account service — wraps better-auth client for change-name / change-email
 * / change-password and our own deletion grace period endpoints.
 *
 * Why a separate service module: the settings UI shouldn't know which
 * paths come from better-auth vs our custom routes. This file is the
 * boundary.
 */
import { authClient } from '../lib/auth-client';
import { apiClient } from '../lib/axios-config';

export interface DeletionStatus {
  pending: boolean;
  requestedAt?: string;
  scheduledAt?: string;
  daysLeft?: number;
}

export interface AccountSessionSummary {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  isCurrent: boolean;
}

export const accountService = {
  // ----- name / email / password -----

  async changeName(name: string): Promise<void> {
    const result = await authClient.updateUser({ name });
    if (result.error) throw new Error(result.error.message ?? 'Update name failed');
  },

  async requestEmailChange(newEmail: string): Promise<void> {
    const result = await authClient.emailOtp.requestEmailChange({ newEmail });
    if (result.error) throw new Error(result.error.message ?? 'Request email change failed');
  },

  async confirmEmailChange(newEmail: string, otp: string): Promise<void> {
    const result = await authClient.emailOtp.changeEmail({ newEmail, otp });
    if (result.error) throw new Error(result.error.message ?? 'Change email failed');
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const result = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    if (result.error) throw new Error(result.error.message ?? 'Change password failed');
  },

  // ----- session list -----

  async listSessions(): Promise<AccountSessionSummary[]> {
    const { data } = await apiClient.get<AccountSessionSummary[]>('/api/account/sessions');
    return data;
  },

  async revokeSession(sessionId: string): Promise<void> {
    await apiClient.delete(`/api/account/sessions/${encodeURIComponent(sessionId)}`);
  },

  // ----- deletion grace period -----

  async getDeletionStatus(): Promise<DeletionStatus> {
    const { data } = await apiClient.get<DeletionStatus>('/api/account/deletion');
    return data;
  },

  async requestDeletion(reason?: string): Promise<DeletionStatus> {
    const { data } = await apiClient.post<DeletionStatus>('/api/account/deletion', { reason });
    return data;
  },

  async cancelDeletion(): Promise<void> {
    await apiClient.delete('/api/account/deletion');
  },
};
