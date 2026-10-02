/** Synthetic browser layout acceptance; not imported by the application. */
import { useLayoutEffect, useState } from 'react';
import { AgentTypographyFixture, measureAgentTypography } from './agent-typography-fixture';
import { createRoot } from 'react-dom/client';
import { LeftSidebarHeader } from '../src/renderer/components/leftBars/LeftSidebarHeader';
import { RightSidebarHeader } from '../src/renderer/components/rightBars/RightSidebarHeader';
import { useSidebarMetricsStore } from '../src/renderer/store/sidebar-metrics-store';
import { useUiStore } from '../src/renderer/store/ui-store';
import { DesktopSidebarLayout } from '../src/renderer/shells/desktop/DesktopSidebarLayout';
import { sidebarSplitMinWidth } from '../src/renderer/lib/layout-geometry';
import { ContextMenuSurface } from '../src/renderer/components/ui/ContextMenuSurface';
import { AppearancePanel } from '../src/renderer/features/settings/panels/BasicPreferencePanels';
import { useSettingsStore } from '../src/renderer/store/settings-store';
import { applyInterfaceTextSize } from '../src/renderer/lib/interface-typography';
import { setI18nLocale } from '../src/renderer/lib/i18n';
import '@fontsource-variable/inter-tight';
import '../src/styles/index.css';
import '../src/styles/ui-controls.css';
import '../src/styles/settings.css';
import '../src/styles/bottom-status-bar.css';
import '../src/styles/desktop-typography.css';

const root = document.documentElement;
setI18nLocale(new URLSearchParams(location.search).get('locale') === 'en' ? 'en' : 'zh-CN');
root.dataset.shellMode = 'desktop';
root.style.setProperty('--editor-font-size', '21px');
document.body.style.overflow = 'auto';

function element(selector: string): HTMLElement {
  const result = document.querySelector<HTMLElement>(selector);
  if (!result) throw new Error(`Missing ${selector}`);
  return result;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function SidebarFixture({ side }: { side: 'left' | 'right' }) {
  const layout = useUiStore((s) => s.desktopSidebarTabs[side]);
  const width = useUiStore((s) => s.sidebars[side].width);
  const panels = layout.panes.map((pane) => ({
    ...pane,
    header: side === 'left'
      ? <LeftSidebarHeader paneId={pane.id} activeTab="nodes" />
      : <RightSidebarHeader paneId={pane.id} activeTab="review" />,
    content: <div>Synthetic panel</div>,
  }));
  return <div id={`sidebar-${side}`} style={{ width, height: 70, marginTop: 16 }}>
    <DesktopSidebarLayout side={side} panels={panels} />
  </div>;
}

async function measureSidebars() {
  const samples = [];
  for (const locale of ['zh-CN', 'en']) {
    setI18nLocale(locale);
    await document.fonts.ready;
    await frame(); await frame();
    for (const side of ['left', 'right'] as const) {
      const min = useSidebarMetricsStore.getState().minimumWidths[side];
      const threshold = sidebarSplitMinWidth(min);
      for (const width of [min, threshold - 1, threshold]) {
        useUiStore.getState().setSidebarWidth(side, width);
        await frame(); await frame();
        const rows = [...element(`#sidebar-${side}`).querySelectorAll<HTMLElement>('.workspace-panel-tab-row')];
        const fits = rows.every((row) => {
          const labels = [...row.querySelectorAll<HTMLElement>('[data-panel-tab-label]')].map((label) => label.getBoundingClientRect());
          const bounds = row.getBoundingClientRect();
          return labels.every((label, i) => label.left >= bounds.left + 5.9 && label.right <= bounds.right - 5.9
            && (i === 0 || label.left - labels[i - 1].right >= 11.9));
        });
        const panes = rows.length;
        samples.push({ locale, side, min, threshold, width, panes, fits,
          passed: min > 0 && fits && panes === (width >= threshold ? 2 : 1) });
      }
    }
  }
  setI18nLocale(new URLSearchParams(location.search).get('locale') === 'en' ? 'en' : 'zh-CN');
  return samples;
}

function contrast(foreground: string, background: string): number {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d')!;
  const luminance = (color: string) => {
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const values = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
      const value = v / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function measure() {
  await document.fonts.ready;
  const checks: Record<string, boolean> = {};
  const samples: Record<string, unknown>[] = [];
  const before = { size: root.dataset.interfaceTextSize, dark: root.classList.contains('dark') };
  root.dataset.typographyMeasuring = 'true';
  try {
    for (const dark of [false, true]) for (const size of ['small', 'standard', 'large'] as const) {
      root.classList.toggle('dark', dark);
      useSettingsStore.getState().setInterfaceTextSize(size);
      applyInterfaceTextSize(size);
      await frame(); await frame();
      const key = `${dark ? 'dark' : 'light'}:${size}`;
      const item = element('#long-menu-item');
      const menu = element('.context-menu-surface');
      const footer = element('.bsb');
      const menuStyle = getComputedStyle(menu), footerStyle = getComputedStyle(footer);
      const increment = size === 'large' ? 2 : 0;
      const expected = size === 'small'
        ? { body: 12.5, caption: 10, panelTab: 11.5, description: 12, heading: 10 }
        : { body: 14 + increment, caption: 12 + increment, panelTab: 13 + increment, description: 13 + increment, heading: 16 + increment };
      const sizes = {
        body: menuStyle.fontSize,
        caption: footerStyle.fontSize,
        panelTab: getComputedStyle(element('.app-panel-tab--label')).fontSize,
        description: getComputedStyle(element('.set-row__desc')).fontSize,
        heading: getComputedStyle(element('.set-sec__title')).fontSize,
      };
      for (const role of Object.keys(expected) as (keyof typeof expected)[]) {
        checks[`${key}:${role}`] = parseFloat(sizes[role]) === expected[role];
      }
      checks[`${key}:prose`] = getComputedStyle(element('.ProseMirror')).fontSize === '21px';
      checks[`${key}:wrapping`] = item.scrollHeight <= item.clientHeight + 1 && item.scrollWidth <= item.clientWidth + 1;
      checks[`${key}:portal`] = menu.parentElement === document.body;
      const bounds = menu.getBoundingClientRect();
      checks[`${key}:viewport`] = bounds.right <= innerWidth && bounds.bottom <= innerHeight;
      checks[`${key}:footerInset`] = parseFloat(getComputedStyle(element('#overlay-boundary')).bottom) === footer.getBoundingClientRect().height;
      const ratio = contrast(footerStyle.color, footerStyle.backgroundColor);
      checks[`${key}:contrast`] = ratio >= 4.5;
      checks[`${key}:settingsFit`] = [...document.querySelectorAll<HTMLElement>('.set-row')].every((row) => row.scrollWidth <= row.clientWidth + 1);
      for (const control of document.querySelectorAll<HTMLElement>('.segmented-control__option, .app-panel-tab')) {
        checks[`${key}:${control.textContent}`] = control.clientHeight >= parseFloat(getComputedStyle(control).lineHeight);
      }
      const agent = measureAgentTypography(size);
      checks[`${key}:agentConversation`] = agent.passed;
      const sidebars = await measureSidebars();
      checks[`${key}:sidebarDensity`] = sidebars.every((sample) => sample.passed);
      samples.push({ key, sidebars, agent: agent.samples, ...sizes, footerHeight: footer.getBoundingClientRect().height, contrast: Number(ratio.toFixed(2)) });
    }
    root.dataset.shellMode = 'mobile';
    await frame();
    checks.mobileFallback = getComputedStyle(element('.menu-surface')).fontSize === '12.5px';
    checks.mobileProse = getComputedStyle(element('.ProseMirror')).fontSize === '21px';
  } finally {
    root.dataset.shellMode = 'desktop';
    root.classList.toggle('dark', before.dark);
    useSettingsStore.getState().setInterfaceTextSize(before.size as 'small' | 'standard' | 'large');
    applyInterfaceTextSize(before.size);
    delete root.dataset.typographyMeasuring;
  }
  return { status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', viewport: [innerWidth, innerHeight], checks, samples };
}

export function Fixture() {
  const textSize = useSettingsStore((s) => s.interfaceTextSize);
  const theme = useSettingsStore((s) => s.themeMode);
  const [report, setReport] = useState<Awaited<ReturnType<typeof measure>> | null>(null);
  useLayoutEffect(() => applyInterfaceTextSize(textSize), [textSize]);
  useLayoutEffect(() => { root.classList.toggle('dark', theme === 'dark'); }, [theme]);
  return (
    <main style={{ padding: 24, maxWidth: 880, margin: 'auto' }}>
      <style>{`html[data-typography-measuring] *, html[data-typography-measuring] { transition: none !important; }`}</style>
      <h1 style={{ fontSize: 22 }}>桌面字号 · Synthetic layout acceptance</h1>
      <p>真实 UI 组件与样式，合成文本；不读取项目或稿件。</p>
      <button className="ui-button ui-button--md" onClick={() => void measure().then(setReport)}>Run layout checks</button>
      <details>
        <summary>{report ? `Layout checks: ${report.status}` : 'Not run'}</summary>
        <output id="typography-result" style={{ display: 'block', whiteSpace: 'pre-wrap', fontSize: 13 }}>{report ? JSON.stringify(report, null, 2) : 'Not run'}</output>
      </details>
      {report && <a download={`desktop-typography-${innerWidth}.json`} href={`data:application/json,${encodeURIComponent(JSON.stringify(report, null, 2))}`}>Download report</a>}
      <SidebarFixture side="left" />
      <SidebarFixture side="right" />
      <footer className="bsb">12,345 字 · 今日新增 678 字</footer>
      <div id="overlay-boundary" style={{ position: 'fixed', bottom: 'var(--super-view-bottom-inset)', pointerEvents: 'none' }} />
      <div className="page__body"><div className="ProseMirror">正文保持作者选择的 21px。Manuscript typography stays independent.</div></div>
      <AgentTypographyFixture />
      <AppearancePanel registerRef={() => {}} />
      <ContextMenuSurface x={innerWidth - 220} y={48} onClose={() => {}} ariaLabel="Synthetic menu">
        <div className="menu-surface__section-label">章节操作</div>
        <button id="long-menu-item" className="menu-surface__item">将这个很长的章节名称移动到另一条故事线 / Move chapter to another storyline</button>
        <button className="menu-surface__item">复制链接</button>
      </ContextMenuSurface>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
