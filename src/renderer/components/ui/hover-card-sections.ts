import type { HoverAction, HoverActionGroup } from './HoverCard';

export type HoverCardSection =
  | { type: 'plain'; key: string; actions: HoverAction[] }
  | { type: 'fixed'; key: string; label: string; actions: HoverAction[] }
  | { type: 'folded'; key: string; action: HoverAction };

/**
 * The card's groups as sections, parted by a hairline: plain actions, a fixed
 * choice (its header and its choices), each action that offers choices as a
 * folded section of its own, and whatever is dangerous gathered last.
 */
export function hoverCardSections(groups: HoverActionGroup[]): HoverCardSection[] {
  const sections: HoverCardSection[] = [];
  const danger: HoverAction[] = [];
  for (const group of groups) {
    const actions = group.actions.filter((action) => {
      if (!action.danger || action.choices) return true;
      danger.push(action);
      return false;
    });
    if (actions.length === 0) continue;
    if (group.label) {
      sections.push({ type: 'fixed', key: group.key, label: group.label, actions });
      continue;
    }
    let run: HoverAction[] = [];
    const flush = () => {
      if (run.length > 0) sections.push({ type: 'plain', key: `${group.key}:${sections.length}`, actions: run });
      run = [];
    };
    for (const action of actions) {
      if (action.choices) {
        flush();
        sections.push({ type: 'folded', key: `${group.key}:${action.key}`, action });
      } else {
        run.push(action);
      }
    }
    flush();
  }
  if (danger.length > 0) sections.push({ type: 'plain', key: 'danger', actions: danger });
  return sections;
}

/** A section header that opens more takes no trailing ellipsis of its own. */
export function sectionTitle(label: string) {
  return label.replace(/[….]+$/u, '');
}
