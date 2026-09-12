import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { ReferenceIndexNotice } from '../src/renderer/components/editor/ReferenceIndexNotice';
import zh from '../src/renderer/locales/zh-CN.json';
import en from '../src/renderer/locales/en.json';
import '../src/styles/index.css';
import '../src/styles/entity-editors.css';
import * as fixture from './reference-index-ui-service';

const host = document.getElementById('reference-status-root')!;
const root = createRoot(host);
const i18n = createInstance();
await i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zh }, en: { translation: en } } });
let commits = 0;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
function render(projectId: string) {
  flushSync(() => root.render(
    <Profiler id="reference-status" onRender={() => { commits += 1; }}>
      <I18nextProvider i18n={i18n}><ReferenceIndexNotice projectId={projectId} /></I18nextProvider>
    </Profiler>,
  ));
}

async function run() {
  render('a');
  await frame();
  const mounted = commits;
  assert(mounted === 1, 'profiling renderer must observe the mounted component');
  for (let index = 0; index < 100; index += 1) flushSync(() => fixture.publish('a', false));
  await frame();
  const healthyProgressCommits = commits - mounted;
  assert(healthyProgressCommits === 0, 'healthy progress caused React commits');
  assert(host.textContent === '', 'healthy status must be invisible');
  flushSync(() => fixture.publish('a', true));
  await frame();
  assert(host.querySelector('[role="status"]')?.textContent?.includes(zh.referencesPanel.updateFailed), 'failure notice missing');
  flushSync(() => host.querySelector('button')!.click());
  assert(fixture.retries.length === 1 && fixture.retries[0] === 'a', 'retry must target the displayed project');
  flushSync(() => fixture.publish('a', false));
  assert(host.textContent === '', 'recovery must hide the notice');
  flushSync(() => fixture.publish('a', true));
  render('b');
  await frame();
  assert(fixture.subscriptions('a') === 0 && fixture.subscriptions('b') === 1, 'project switch retained an old subscription');
  flushSync(() => fixture.publish('a', true));
  assert(host.textContent === '', 'old project error leaked into the current view');
  flushSync(() => root.render(null));
  assert(fixture.subscriptions('b') === 0, 'unmount retained a status subscription');
  return {
    mountedCommits: mounted, healthyNotifications: 100, healthyProgressCommits,
    checks: ['failure-visible', 'retry-project-identity', 'recovery-hides-notice', 'project-switch', 'unmount-cleanup'].map((id) => ({ id, passed: true })),
  };
}

async function show(language: string, dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
  await i18n.changeLanguage(language);
  fixture.publish('preview', true);
  render('preview');
  await frame();
  await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  await frame();
  const status = host.querySelector<HTMLElement>('[role="status"]')!;
  const button = status.querySelector('button')!;
  const statusRect = status.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  assert(status.scrollWidth <= status.clientWidth, 'notice overflows');
  assert(buttonRect.width > 0 && buttonRect.right <= statusRect.right, 'retry is outside the notice');
  return { language, dark, viewportWidth: innerWidth, noticeWidth: statusRect.width, noticeHeight: statusRect.height, fits: true };
}

Object.assign(window, { __REFERENCE_INDEX_UI__: { run, show } });
