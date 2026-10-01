/** Display preference only; manuscript typography has its own owner. */
export type InterfaceTextSize = 'small' | 'standard' | 'large';

export function normalizeInterfaceTextSize(value: unknown): InterfaceTextSize {
  return value === 'small' || value === 'large' ? value : 'standard';
}

export function applyInterfaceTextSize(value: unknown): void {
  document.documentElement.dataset.interfaceTextSize = normalizeInterfaceTextSize(value);
}
