import { BrushIcon, type BrushIconName } from './BrushIcon';
import { KindMark } from './KindMark';
import type { KindMarkKind } from './kind-mark';

/**
 * What leads a menu row: a brush icon, or the kind mark of the thing the row
 * makes or turns something into (a drift converted to a chapter leads with
 * the chapter's seal).
 */
export type MenuRowIconSpec = BrushIconName | { kind: KindMarkKind };

export function MenuRowIcon({ icon }: { icon: MenuRowIconSpec }) {
  return typeof icon === 'string' ? <BrushIcon name={icon} size={16} /> : <KindMark kind={icon.kind} />;
}
