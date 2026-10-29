import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { designSystemDocs } from '../components/design-system-docs.test-support';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));
const runtime = vi.hoisted(() => ({ isMobileShell: false }));
vi.mock('../platform/runtime', () => ({ getPlatformRuntime: () => runtime }));
vi.mock('../sync/hosted/sign-in', () => ({ finishHostedSignIn: async () => undefined }));
vi.mock('../lib/auth-client', () => ({ authClient: {} }));
vi.mock('../platform', () => ({
  platform: { auth: { onOAuthCallback: () => () => {} }, material: { openExternal: async () => undefined } },
}));

import { AuthFlow } from '../features/auth/AuthFlow';

const root = resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

function block(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

afterEach(() => {
  runtime.isMobileShell = false;
});

describe('the bookshelf in sand and glass', () => {
  const view = read('src/renderer/views/ProjectPickerView.tsx');
  const css = read('src/styles/project-picker.css');

  it('writes the shelf straight on the desk, with no boxes, washes or accent blocks', () => {
    expect(block(css, '.pp {', '}')).toContain('background: var(--workspace-ui-bg);');
    const desk = css.slice(0, css.indexOf("/* ─── The paused mobile shelf's modals"));
    expect(desk).not.toContain('hsl(var(--surface))');
    expect(desk).not.toContain('background: hsl(var(--accent))');
    expect(desk).not.toMatch(/border(-left)?:\s*1px solid/);
    expect(desk).not.toMatch(/box-shadow:\s*0 /);
    // The header is the shelf's name and a round glass avatar; no kicker or subtitle.
    expect(view).not.toContain("t('projectPicker.header.workspace')");
    expect(view).not.toContain("t('projectPicker.header.subtitle')");
    expect(view).toContain('className="pp-head__account"');
  });

  it('runs the toolbar on the shared controls', () => {
    expect(view).toContain('<GlassSlider');
    expect(view).toContain('className="pp-bar__search ui-field glass glass--rest glass--field"');
    expect(view).toContain('className="pp-bar__view glass--rest"');
    expect(view).toContain('aria-pressed={view === value}');
    expect(view).not.toContain('<FilterChip');
    expect(view).not.toContain('pp-toolbar__btn--accent');
  });

  it('flows each book’s storylines down its cover as sand, seeded by the book', () => {
    expect(view).toContain('className="sand pp-cover__band"');
    expect(view).toContain("'--sand-mask': `url(${mask})`");
    expect(view).toContain('seed: coverSeed(project.id)');
    expect(view).toContain('<KindMark kind="all" />');
    expect(block(css, '.pp-cover {', '}')).toContain('background: hsl(var(--page));');
    expect(read('src/renderer/usecase/useProject.ts')).toContain('const cover = await readProjectCover(project.id);');
  });

  it('makes a book a resting line of glass with a sand readout, and a list row a cell', () => {
    expect(view).toContain('<article className="pp-card glass glass--rest">');
    expect(view).toContain('<SandCell selected={false} className="pp-row">');
    expect(view).toContain('className="sand-track"');
    expect(view).toContain('<span className="sand-stroke"');
    expect(block(css, '.pp-card {', '}')).toMatch(/background: transparent;[\s\S]*box-shadow: none;/);
    expect(view).toContain('mark="all"');
  });

  it('builds the desktop dialogs on the shared shell, and keeps the mobile modals', () => {
    expect(view).toContain('function TrashDialog(');
    expect(view).toContain('function RecentlyDeletedDialog(');
    expect(view).toContain('function ProjectFormDialog(');
    expect(view.match(/<ModalRoot /g)).toHaveLength(3);
    expect(view).toContain('<Button variant="danger" onClick={onConfirm} disabled={busy}>');
    // A destructive confirmation opens on Cancel.
    expect(view).toContain('<Button onClick={onClose} disabled={busy} autoFocus>');
    expect(view).toContain('className="ui-field ui-field--area glass glass--rest glass--field"');
    // The paused mobile shelf still renders its own .pp-modal markup.
    expect(view).toContain('function DeleteModal(');
    expect(view).toContain('function ProjectFormModal(');
    expect(css).toContain('width: min(100%, 500px) !important');
  });
});

describe('danger buttons', () => {
  it('are a resting line of glass in the danger’s own colour, across the app', () => {
    const controls = read('src/styles/ui-controls.css');
    const danger = block(
      controls,
      "html:not([data-shell-mode='mobile']) .ui-button.ui-button--glass.ui-button--danger,",
      '}',
    );
    expect(danger).toContain('--glass-cc: hsl(var(--destructive));');
    expect(danger).toContain('color: hsl(var(--destructive));');
    // Disabled, every glass button falls back to a faint clear line.
    expect(block(controls, "html:not([data-shell-mode='mobile']) .ui-button.ui-button--glass:disabled {", '}'))
      .toContain('--glass-cc: var(--glass-clear);');
  });
});

describe('the sign-in dialog', () => {
  const render = (presentation: 'dialog' | 'page', initialMode: 'signin' | 'signup' = 'signin') =>
    renderToStaticMarkup(createElement(AuthFlow, { presentation, initialMode, onComplete: () => {}, onClose: () => {} }));

  it('is made of the shared controls on the desktop', () => {
    const html = render('dialog');
    expect(html).toContain('class="auth-flow auth-flow--dialog"');
    expect(html.match(/class="ui-field glass glass--rest glass--field"/g)).toHaveLength(2);
    expect(html).toMatch(/class="ui-button ui-button--primary ui-button--md ui-button--glass glass glass--primary glass--small auth-flow__glass-button auth-flow__glass-button--primary auth-flow__glass-button--block"/);
    expect(html).toContain('auth-flow__glass-button--text');
    expect(html).toContain('auth-flow__glass-button--foot');
    expect(html).not.toContain('auth-flow__button--primary');
    expect(render('dialog', 'signup').match(/class="ui-field /g)).toHaveLength(3);
  });

  it('keeps the paused mobile page as it was', () => {
    const html = render('page');
    expect(html).toContain('class="auth-flow auth-flow--page"');
    expect(html).toContain('auth-flow__button auth-flow__button--primary auth-flow__button--block');
    expect(html).not.toContain('ui-field');
    expect(html).not.toContain('ui-button');
  });

  it('says errors in the danger ink, with no wash, on the desktop', () => {
    const css = read('src/styles/auth.css');
    const error = block(css, '.auth-flow--dialog .auth-flow__error {', '}');
    expect(error).toContain('background: transparent;');
    expect(block(css, '.auth-flow--dialog .auth-flow__foot {', '}')).toMatch(/border-top: 0;[\s\S]*background: transparent;/);
  });
});

describe('the design-system docs', () => {
  it('record the shelf, the sign-in dialog and the red danger glass', () => {
    const doc = designSystemDocs();
    expect(doc).toContain('## 书架');
    expect(doc).toContain('## 登录与注册');
    expect(doc).toContain('`lib/sand-cover.ts`');
    expect(doc).toContain('危险色的玻璃只有一处');
  });
});
