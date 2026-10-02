export interface SettingsNavigationSection {
  id: string;
  label: string;
  element: HTMLElement;
  searchText: string;
}

export type SettingsNavigationIndex = Record<string, {
  searchText: string;
  sections: SettingsNavigationSection[];
}>;

const normalizeSearchText = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/** Index rendered copy in document order, including panels without subsection headings. */
export function readSettingsNavigation(main: HTMLElement): SettingsNavigationIndex {
  const index: SettingsNavigationIndex = {};
  for (const panel of main.querySelectorAll<HTMLElement>('.set-panel[id]')) {
    if (!panel.getClientRects().length) continue;
    const sections: SettingsNavigationSection[] = [];
    const panelText: string[] = [];
    const sectionText: string[][] = [];
    const append = (text: string) => {
      panelText.push(text);
      sectionText[sectionText.length - 1]?.push(text);
    };
    const visit = (element: HTMLElement) => {
      // Search explanatory copy, never input values or concealed/retired content.
      if (element.matches('[hidden], [aria-hidden="true"], input, textarea, select, script, style, template')) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return;
      const label = element.dataset.settingsSection?.trim();
      if (label && element.id && element.getClientRects().length) {
        sections.push({ id: element.id, label, element, searchText: '' });
        sectionText.push([]);
      }
      const block = !style.display.startsWith('inline') && style.display !== 'contents';
      if (block || element.tagName === 'BR') append(' ');
      const children = element.matches('details:not([open])')
        ? Array.from(element.children).filter(child => child.tagName === 'SUMMARY').slice(0, 1)
        : element.childNodes;
      for (const child of children) {
        if (child.nodeType === 3) append(child.textContent ?? '');
        else if (child.nodeType === 1) visit(child as HTMLElement);
      }
      if (block) append(' ');
    };
    visit(panel);
    sections.forEach((section, position) => { section.searchText = normalizeSearchText(sectionText[position].join('')); });
    index[panel.id] = { searchText: normalizeSearchText(panelText.join('')), sections };
  }
  return index;
}

export function sameSettingsNavigation(previous: SettingsNavigationIndex, next: SettingsNavigationIndex): boolean {
  return Object.keys(previous).length === Object.keys(next).length &&
    Object.entries(next).every(([id, panel]) => previous[id]?.searchText === panel.searchText &&
      previous[id]?.sections.length === panel.sections.length &&
      panel.sections.every((section, position) => {
        const old = previous[id].sections[position];
        return old.id === section.id && old.label === section.label && old.element === section.element &&
          old.searchText === section.searchText;
      }));
}

export function filterSettingsNavigation<T extends { id: string; label: string }>(
  items: T[], index: SettingsNavigationIndex, query: string,
): (T & { sections: SettingsNavigationSection[] })[] {
  const q = normalizeSearchText(query);
  return items.flatMap((item) => {
    const panel = index[item.id];
    const children = panel?.sections ?? [];
    const parentMatches = !q || normalizeSearchText(item.label).includes(q) || item.id.includes(q);
    const matches = parentMatches ? children : children.filter(child =>
      normalizeSearchText(child.label).includes(q) || child.searchText.includes(q));
    return parentMatches || matches.length || panel?.searchText.includes(q)
      ? [{ ...item, sections: matches }] : [];
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
