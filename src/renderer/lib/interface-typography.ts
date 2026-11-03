/** Display preference only; manuscript typography has its own owner. */
export type InterfaceTextSize = 'smallest' | 'small' | 'standard' | 'large' | 'largest';

export function normalizeInterfaceTextSize(value: unknown): InterfaceTextSize {
  return value === 'smallest' || value === 'small' || value === 'large' || value === 'largest'
    ? value : 'standard';
}

export function applyInterfaceTextSize(value: unknown): void {
  document.documentElement.dataset.interfaceTextSize = normalizeInterfaceTextSize(value);
}

/**
 * Kana, Hangul and ideographs. In the structure face the Latin font sets the line and
 * these come from its fallback, sitting about 0.15em higher on it; labels that
 * centre in a tab or a glass slab mark them with `data-script="cjk"` to drop.
 */
export const CJK_TEXT = /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
