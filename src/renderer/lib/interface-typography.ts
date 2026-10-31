/** Display preference only; manuscript typography has its own owner. */
export type InterfaceTextSize = 'small' | 'standard' | 'large';

export function normalizeInterfaceTextSize(value: unknown): InterfaceTextSize {
  return value === 'small' || value === 'large' ? value : 'standard';
}

export function applyInterfaceTextSize(value: unknown): void {
  document.documentElement.dataset.interfaceTextSize = normalizeInterfaceTextSize(value);
}

/**
 * Kana and ideographs. In the structure face the Latin font sets the line and
 * these come from its fallback, sitting about 0.15em higher on it; labels that
 * centre in a tab or a glass slab mark them with `data-script="cjk"` to drop.
 */
export const CJK_TEXT = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
