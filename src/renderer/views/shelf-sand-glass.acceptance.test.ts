import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
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
    // A double click on the open desk selects no words.
    expect(block(css, '.pp {', '}')).toContain('-webkit-user-select: none;');
    const modalsAt = css.indexOf("/* ─── The paused mobile shelf's modals");
    const desk = modalsAt < 0 ? css : css.slice(0, modalsAt);
    expect(desk).not.toContain('hsl(var(--surface))');
    expect(desk).not.toContain('background: hsl(var(--accent))');
    expect(desk).not.toMatch(/border(-left)?:\s*1px solid/);
    expect(desk).not.toMatch(/box-shadow:\s*0 /);
    // The shelf's name heads the rail; no kicker or subtitle.
    expect(view).not.toContain("t('projectPicker.header.workspace')");
    expect(view).not.toContain("t('projectPicker.header.subtitle')");
    expect(read('src/renderer/views/shelf/ShelfRail.tsx')).toContain(
      `<h1 className="pp-head__title">{t('projectPicker.header.titleEm')}</h1>`,
    );
  });

  it('holds only the rail, the heatmap, the books and the cover-style button at its foot', () => {
    // A writer’s shelf never grows long enough to need a toolbar, a list
    // view or a footer: no filters, search, view switch or 新建作品 button.
    for (const gone of ['pp-bar', 'pp-foot', 'pp-list', 'pp-row', 'ProjectListRow', '<GlassSlider', 'pp-empty-state']) {
      expect(view, gone).not.toContain(gone);
      expect(css, gone).not.toContain(gone);
    }
    // Every book, then the slip to start the next one; an empty shelf is that slip alone.
    expect(view).toContain('{decorated.map((row) => (');
    expect(view).toContain('className="pp-card pp-card--new"');
    // The rail, like the workspace's left column: import, Recently Deleted
    // and the account cell with the library's sync state, opening the
    // account menu upward. Import and Recently Deleted left the menu.
    expect(view).toContain('<ShelfRail');
    expect(view).toContain('trashCount={trashed.length}');
    expect(view).toContain('onOpenTrash={() => setTrashOpen(true)}');
    expect(view).toContain('onImport={() => void handleImport()}');
    const rail = read('src/renderer/views/shelf/ShelfRail.tsx');
    expect(rail).toContain('<span className="pp-rail__meta">.driftingbook</span>');
    expect(rail).toContain("title={t('userMenu.importBook')}");
    expect(rail).toContain("{t('projectPicker.desk.trashEntry')}");
    expect(rail).toContain('const corner = syncLibraryCornerFor(health);');
    expect(rail).toContain('placement="top-start"');
    // The notification bell sits beside the account cell, as at the foot of
    // the workspace's left sidebar, and its center opens upward.
    expect(rail).toContain('<NotificationPill opens="up" />');
    expect(block(css, '.pp-rail__foot {', '}')).toContain('display: flex;');
    expect(block(css, '.pp-rail__account {', '}')).toContain('flex: 1;');
    expect(block(css, '.pp-rail__cell {', '}')).toContain('background: transparent;');
    // Label and meta are never cut short: the meta goes under the label where
    // both do not fit on one line (English), and a long label wraps.
    expect(block(css, '.pp-rail__cell {', '}')).toContain('min-height: 32px;');
    expect(block(css, '.pp-rail__text {', '}')).toContain('flex-wrap: wrap;');
    const label = block(css, '.pp-rail__label {', '}');
    expect(label).not.toContain('text-overflow: ellipsis');
    expect(label).not.toContain('white-space: nowrap');
    expect(block(css, '.pp-rail {', '}')).toContain('position: sticky;');
    const menu = read('src/renderer/components/topBars/UserMenu.tsx');
    expect(menu).not.toContain('onOpenTrash');
    expect(menu).not.toContain("t('userMenu.importBook')");
    // A year of writing days above the books: sand masks coloured in CSS, a
    // still glass card the sea draws, the book under the pointer alone.
    expect(view).toContain('{year && <WritingHeatmap year={year} books={heatBooks} focusId={focusId} />}');
    const heat = read('src/renderer/views/shelf/WritingHeatmap.tsx');
    expect(heat).toContain("className={`pp-heat glass glass--rest glass--still${drawn ? ' pp-heat--sea' : ''}`}");
    expect(heat).toContain('className="sand pp-heat__layer"');
    expect(heat).toContain("const daily = focus ? (year.byProject[focus.id] ?? zeros) : year.total;");
    expect(heat).toContain('<HoverCardShell anchor={hotElement} placement="top-center"');
    expect(css).toContain('.pp-heat--sea.glass::before');
    // Each card's last 30 days: one ink stroke per day written.
    expect(view).toContain('<SandStrip');
    expect(read('src/renderer/views/shelf/SandStrip.tsx')).toContain('className="sand pp-strip__sand"');
    // Below the books, one round glass button turns every cover to the next style.
    const foot = block(view, '<div className="pp-cover-style">', '</div>');
    expect(foot).toContain('glass="round"');
    expect(foot).toContain('<BrushIcon name="rotate" size={16} />');
    expect(foot).toContain('onClick={() => turnCoverStyle()}');
    expect(foot).toContain('t(`projectPicker.desk.coverStyle.names.${coverStyle}`)');
    expect(block(css, '.pp-cover-style {', '}')).toContain('margin-top: auto;');
  });

  it('draws each book’s storylines on its cover in the shelf’s style, seeded by the book and remembered on the device', () => {
    // Sand is a mask per storyline coloured in CSS; every other style is one picture of the slip.
    expect(view).toContain('className="sand pp-cover__band"');
    expect(view).toContain("'--sand-mask': `url(${mask})`");
    expect(view).toContain('className="pp-cover__art"');
    expect(view).toContain('seed: coverSeed(project.id)');
    expect(view).toContain('useSyncExternalStore(subscribeCoverStyle, readCoverStyle, readCoverStyle)');
    expect(read('src/renderer/lib/shelf-cover/preference.ts')).toContain("const STYLE_KEY = 'shelf:cover-style';");
    // Drawn off the page where the WebView allows it, with the page as the fallback.
    const covers = read('src/renderer/lib/shelf-cover/covers.ts');
    expect(covers).toContain("new Worker(new URL('./shelf-cover.worker.ts', import.meta.url), { type: 'module' })");
    expect(covers).toContain('return drawOnPage(style, request);');
    // The genre keeps a fixed ink, light on a dark ground. The cover has
    // neither a title initial nor an untitled-book mark; the landing demo agrees.
    expect(block(css, '.pp-cover--art.pp-cover--dark .pp-cover__label {', '}')).toContain('color: hsl(40 12% 92% / 0.66);');
    expect(view).not.toContain('pp-cover__glyph');
    expect(view).not.toContain('<KindMark');
    expect(css).not.toContain('pp-cover__glyph');
    const landing = read('scripts/design-assets/landing/index.html');
    expect(landing).not.toContain('cover-glyph');
    expect(landing).not.toContain('cover-label');
    expect(block(css, '.pp-cover {', '}')).toContain('background: hsl(var(--page));');
    expect(read('src/renderer/usecase/useProject.ts')).toContain('const cover = await readProjectCover(project.id);');
  });

  it('makes a book a resting line of glass with a sand readout', () => {
    // On the desktop the sea of characters draws the resting glass (char-sea.acceptance.test.ts).
    expect(view).toContain("className={`pp-card glass glass--rest${sample.waiting ? ' glass--waiting' : ''}${seaDrawn ? ' pp-card--sea' : ''}`}");
    expect(view).toContain('className="sand-track"');
    expect(view).toContain('<span className="sand-stroke"');
    expect(block(css, '.pp-card {', '}')).toMatch(/background: transparent;[\s\S]*box-shadow: none;/);
  });

  it('builds the shelf dialogs on the shared shell, on the phone as well', () => {
    expect(view).toContain('function TrashDialog(');
    expect(view).toContain('function RecentlyDeletedDialog(');
    expect(view).toContain('function ProjectFormDialog(');
    expect(view).toContain('function TransferErrorDialog(');
    expect(view.match(/<ModalRoot /g)).toHaveLength(4);
    expect(view).toContain('<Button variant="danger" onClick={onConfirm} disabled={busy}>');
    // A destructive confirmation opens on Cancel.
    expect(view).toContain('<Button onClick={onClose} disabled={busy} autoFocus>');
    expect(view).toContain('className="ui-field ui-field--area glass glass--rest glass--field"');
    // The phone opens the same dialogs: the paused mobile shelf's own
    // .pp-modal markup and its separate shelf content are gone.
    expect(view).not.toContain('function DeleteModal(');
    expect(view).not.toContain('function ProjectFormModal(');
    expect(view).not.toContain('pp-modal');
    expect(view).not.toContain('MobileProjectShelfContent');
    expect(view).toContain('export function ProjectPickerView() {');
  });
});

describe('danger buttons', () => {
  it('are a resting line of glass in the danger’s own colour, across the app', () => {
    const controls = read('src/styles/ui-controls.css');
    const danger = block(
      controls,
      "html[data-shell-mode] .ui-button.ui-button--glass.ui-button--danger,",
      '}',
    );
    expect(danger).toContain('--glass-cc: hsl(var(--destructive));');
    expect(danger).toContain('color: hsl(var(--destructive));');
    // Disabled, every glass button falls back to a faint clear line.
    expect(block(controls, "html[data-shell-mode] .ui-button.ui-button--glass:disabled {", '}'))
      .toContain('--glass-cc: var(--glass-clear);');
  });
});

describe('the sign-in dialog', () => {
  const render = (presentation: 'dialog' | 'page', initialMode: 'signin' | 'signup' = 'signin') =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(AuthFlow, { presentation, initialMode, onComplete: () => {}, onClose: () => {} }),
      ),
    );

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

  it('tabs from the email straight to the password, with Forgot password under it', () => {
    const html = render('dialog');
    const email = html.indexOf('type="email"');
    const password = html.indexOf('type="password"');
    const forgot = html.indexOf('auth.forgotPassword');
    expect(email).toBeGreaterThanOrEqual(0);
    expect(html.slice(email, password)).not.toMatch(/<(button|a)\b/);
    expect(forgot).toBeGreaterThan(password);
  });

  it('keeps the mobile sign-in page on its own controls', () => {
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
    expect(doc).toContain('`lib/shelf-cover/`');
    expect(doc).toContain('危险色的玻璃只有一处');
  });
});
