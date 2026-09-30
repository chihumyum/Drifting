import { useAuthStore } from '../../store/auth';
import { connectHostedFromProduct } from './connect';

/** Called only after the author chooses the explicit Login and sync action. */
export async function finishHostedSignIn(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await useAuthStore.getState().adoptSession();
  signal.throwIfAborted();
  await connectHostedFromProduct(signal);
}
