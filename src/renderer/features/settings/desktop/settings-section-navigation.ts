export interface SettingsNavigationSection {
  id: string;
  label: string;
  element: HTMLElement;
}

export type SettingsSections = Record<string, SettingsNavigationSection[]>;

/** Read mounted, visible headings so conditional sections and translations stay in sync. */
export function readSettingsSections(main: HTMLElement): SettingsSections {
  const sections: SettingsSections = {};
  for (const element of main.querySelectorAll<HTMLElement>('[data-settings-section]')) {
    const panel = element.closest<HTMLElement>('.set-panel');
    const label = element.dataset.settingsSection?.trim();
    if (!panel?.id || !element.id || !label || !element.getClientRects().length) continue;
    (sections[panel.id] ??= []).push({ id: element.id, label, element });
  }
  return sections;
}

export function sameSettingsSections(previous: SettingsSections, next: SettingsSections): boolean {
  return Object.keys(previous).length === Object.keys(next).length &&
    Object.entries(next).every(([id, sections]) => previous[id]?.length === sections.length &&
      sections.every((section, index) => {
        const old = previous[id][index];
        return old.id === section.id && old.label === section.label && old.element === section.element;
      }));
}

export function filterSettingsNavigation<T extends { id: string; label: string }>(
  items: T[], sections: SettingsSections, query: string,
): (T & { sections: SettingsNavigationSection[] })[] {
  const q = query.trim().toLocaleLowerCase();
  return items.flatMap((item) => {
    const children = sections[item.id] ?? [];
    const parentMatches = !q || item.label.toLocaleLowerCase().includes(q) || item.id.includes(q);
    const matches = parentMatches ? children : children.filter(child => child.label.toLocaleLowerCase().includes(q));
    return parentMatches || matches.length ? [{ ...item, sections: matches }] : [];
  });
}

/** offsetTop can use a different offset parent; measure in the scroll container's coordinates. */
export function settingsTargetScrollTop(main: HTMLElement, target: HTMLElement): number {
  return Math.max(0, main.scrollTop + target.getBoundingClientRect().top - main.getBoundingClientRect().top - 16);
}

export function settingsItemAtTop<T extends { element: HTMLElement }>(items: T[], top: number): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index].element.getBoundingClientRect().top <= top) return items[index];
  }
  return undefined;
}
