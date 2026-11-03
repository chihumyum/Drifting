/** Synthetic appearance controls; no project, database or manuscript access. */
import { useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AppearancePanel } from '../src/renderer/features/settings/panels/BasicPreferencePanels';
import { ContextMenuSurface } from '../src/renderer/components/ui/ContextMenuSurface';
import { useSettingsStore } from '../src/renderer/store/settings-store';
import { applyInterfaceTextSize } from '../src/renderer/lib/interface-typography';
import { applyEditorPreferences } from '../src/renderer/lib/editor-preferences';
import { setI18nLocale } from '../src/renderer/lib/i18n';
import '@fontsource-variable/inter-tight';
import '../src/styles/index.css';
import '../src/styles/materials.css';
import '../src/styles/ui-controls.css';
import '../src/styles/settings.css';
import '../src/styles/desktop-typography.css';
import '../src/styles/interface-fonts.css';

const root = document.documentElement;
root.dataset.shellMode = 'desktop';
document.body.style.overflow = 'auto';
useSettingsStore.getState().setBodyFontSize(21);
const sizes = ['smallest', 'small', 'standard', 'large', 'largest'] as const;
const roles = ['body', 'secondary', 'caption', 'emphasis', 'heading'] as const;
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const settle = async () => { await document.fonts.ready; await frame(); await frame(); };
const find = (selector: string) => {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const group = () => find('#appearance [data-value="smallest"]').parentElement!;
const font = (node: Element) => parseFloat(getComputedStyle(node).fontSize);
const fits = (node: HTMLElement) => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1;

export function Fixture() {
  const preferences = useSettingsStore();
  useLayoutEffect(() => {
    applyInterfaceTextSize(preferences.interfaceTextSize);
    applyEditorPreferences(preferences);
  }, [preferences]);
  return <main style={{ padding: 24, maxWidth: 880, margin: 'auto' }}>
    <style>{`*, *::before, *::after { transition: none !important; animation: none !important; }`}</style>
    <AppearancePanel registerRef={() => {}} />
    <div id="roles" style={{ display: 'flex', gap: 12, marginTop: 24 }}>
      {roles.map(role => <span key={role} data-role={role} style={{ fontSize: `var(--ui-font-${role}, 11px)` }}>{role}</span>)}
    </div>
    <div className="page__body"><div className="ProseMirror">合成正文始终保持 21px。Synthetic manuscript text.</div></div>
    <ContextMenuSurface x={innerWidth - 240} y={innerHeight - 110} onClose={() => {}} ariaLabel="Synthetic menu">
      <button className="menu-surface__item">合成菜单 / Synthetic menu</button>
    </ContextMenuSurface>
  </main>;
}

async function run() {
  const samples = [];
  for (const locale of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) {
    setI18nLocale(locale);
    root.classList.toggle('dark', theme === 'dark');
    await settle();
    const labels = locale === 'zh-CN'
      ? ['最小', '较小', '标准', '较大', '最大']
      : ['Smallest', 'Smaller', 'Standard', 'Larger', 'Largest'];
    for (const size of sizes) {
      find(`#appearance [data-value="${size}"]`).click();
      await settle();
      const controls = [...group().querySelectorAll<HTMLElement>('[role="radio"]')];
      const fonts = roles.map(role => font(find(`[data-role="${role}"]`)));
      const increment = { smallest: 0, small: 0, standard: 2, large: 4, largest: 6 }[size];
      const expected = size === 'smallest' ? [11, 11, 11, 11, 11] : [14, 13, 12, 15, 16].map(value => value + increment);
      const menu = find('.context-menu-surface');
      const persisted = JSON.parse(localStorage.getItem('settings-storage')!);
      const checks = {
        labels: JSON.stringify(controls.map(node => node.textContent)) === JSON.stringify(labels),
        selected: controls.filter(node => node.getAttribute('aria-checked') === 'true').map(node => node.dataset.value).join() === size,
        immediate: root.dataset.interfaceTextSize === size,
        persisted: persisted.version === 35 && persisted.state.interfaceTextSize === size,
        roles: JSON.stringify(fonts) === JSON.stringify(expected),
        spacing: parseFloat(getComputedStyle(root).getPropertyValue('--ui-text-increment')) === increment,
        menu: font(menu) === (size === 'smallest' ? 12.5 : 14 + increment) && menu.parentElement === document.body,
        controlsFit: controls.every(fits) && fits(group()),
        settingsFit: [...document.querySelectorAll<HTMLElement>('.set-row')].every(row => row.scrollWidth <= row.clientWidth + 1),
        viewport: group().getBoundingClientRect().right <= innerWidth,
        prose: font(find('.ProseMirror')) === 21 && useSettingsStore.getState().bodyFontSize === 21,
      };
      samples.push({ locale, theme, size, fonts, checks });
    }
  }
  root.dataset.shellMode = 'mobile';
  await settle();
  const mobileFallback = roles.every(role => font(find(`[data-role="${role}"]`)) === 11);
  const mobileProse = font(find('.ProseMirror')) === 21;
  root.dataset.shellMode = 'desktop';
  root.classList.remove('dark');
  setI18nLocale('zh-CN');
  await settle();
  return { status: samples.every(sample => Object.values(sample.checks).every(Boolean)) && mobileFallback && mobileProse ? 'passed' : 'failed',
    viewport: [innerWidth, innerHeight], samples, mobileFallback, mobileProse };
}

Object.assign(window, { __INTERFACE_TEXT_SIZES__: { run, ready: () => Boolean(document.querySelector('[data-value="largest"]')),
  restored: () => ({ size: root.dataset.interfaceTextSize, selected: group().querySelector('[aria-checked="true"]')?.getAttribute('data-value'), prose: font(find('.ProseMirror')) }) } });
createRoot(document.getElementById('root')!).render(<Fixture />);
