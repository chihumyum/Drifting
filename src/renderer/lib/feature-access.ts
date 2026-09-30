/** Recovery is a local writing capability, independent of hosted accounts. */
import { useAuthStore } from '../store/auth';
export type RecoverableFeature = 'trash' | 'snapshot';
export function canUseFeature(_feature: RecoverableFeature): boolean {
  return true;
}
export function useCanUseFeature(_feature: RecoverableFeature): boolean {
  return true;
}
export async function ensureFeatureAccess(
  subjectId: string,
): Promise<void> {
  if (useAuthStore.getState().user.id !== subjectId)
    throw new Error('FEATURE_ACCESS_ACCOUNT_CHANGED');
}
