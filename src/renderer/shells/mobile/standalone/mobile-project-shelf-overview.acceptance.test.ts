import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOBILE_PROJECT_SHELF_SESSION,
  readMobileProjectShelfSession,
  updateMobileProjectShelfSession,
} from './mobile-project-shelf-session';

const root = process.cwd();
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

function memoryStorage(seed?: string) {
  let value = seed ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('mobile project shelf overview', () => {
  it('persists the view, filter, query, scroll and focused project for route return', () => {
    const storage = memoryStorage();
    expect(readMobileProjectShelfSession(storage)).toEqual(DEFAULT_MOBILE_PROJECT_SHELF_SESSION);

    updateMobileProjectShelfSession(
      {
        view: 'overview',
        focusedProjectId: 'project-b',
        overviewScrollTop: 418,
        filter: 'active',
        query: '海',
      },
      storage,
    );

    expect(readMobileProjectShelfSession(storage)).toEqual({
      view: 'overview',
      focusedProjectId: 'project-b',
      overviewScrollTop: 418,
      filter: 'active',
      query: '海',
    });
  });

  it('fails closed to the immersive pager when stored state is malformed', () => {
    expect(readMobileProjectShelfSession(memoryStorage('{broken'))).toEqual(
      DEFAULT_MOBILE_PROJECT_SHELF_SESSION,
    );
    expect(
      readMobileProjectShelfSession(
        memoryStorage(
          JSON.stringify({
            view: 'unknown',
            focusedProjectId: 7,
            overviewScrollTop: -20,
            filter: 'unknown',
            query: 9,
          }),
        ),
      ),
    ).toEqual(DEFAULT_MOBILE_PROJECT_SHELF_SESSION);
  });

  it('uses one explicit grid Toggle and keeps pager dots presentational', () => {
    const shelf = read(
      'src/renderer/shells/mobile/standalone/MobileProjectShelfContent.tsx',
    );
    const picker = read('src/renderer/views/ProjectPickerView.tsx');

    expect(shelf).toContain("useState<MobileProjectShelfView>(initialSession.view)");
    expect(shelf).toContain('className="m-shelf__view-toggle"');
    expect(shelf).toContain('className="m-shelf__view-toggle is-active"');
    expect(shelf).toContain('aria-pressed="false"');
    expect(shelf).toContain('aria-pressed="true"');
    expect(shelf).toContain('data-view="overview"');
    expect(shelf).toContain('<div className="m-shelf-pager__dots" aria-hidden="true">');
    expect(shelf).not.toContain('className="m-shelf__back"');
    expect(shelf).toContain('{allRows.map((row) => {');
    expect(picker).toContain('allRows={decorated}');
  });

  it('opens Project Home from either face and restores the overview session', () => {
    const shelf = read(
      'src/renderer/shells/mobile/standalone/MobileProjectShelfContent.tsx',
    );
    const picker = read('src/renderer/views/ProjectPickerView.tsx');

    expect(shelf).toContain('const openProject = (project: ProjectSummary) =>');
    expect(shelf).toContain('focusedProjectId: project.id');
    expect(shelf).toContain('overviewScrollTop: overviewScrollTopRef.current');
    expect(shelf).toContain('onClick={() => openProject(project)}');
    expect(picker).toContain('updateMobileProjectShelfSession({ filter, query })');
    expect(picker).toContain("navigate(`/project/${id}`");
  });

  it('renders a touch-sized responsive cover overview', () => {
    const css = read('src/styles/mobile-project-shelf.css');
    const foundation = read('docs/mobile-ui-foundation.md');
    const acceptance = read('docs/mobile-device-acceptance.md');

    expect(css).toContain(".m-shelf[data-view='overview']");
    expect(css).toContain('grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));');
    expect(css).toContain('aspect-ratio: 4 / 5;');
    expect(css).toContain('.m-shelf__view-toggle[aria-pressed=\'true\']');
    expect(css).toContain('width: 44px;');
    expect(css).toContain('height: 44px;');
    expect(foundation).toContain('one persistent grid Toggle');
    expect(acceptance).toContain('分页圆点只表达位置');
  });
});
