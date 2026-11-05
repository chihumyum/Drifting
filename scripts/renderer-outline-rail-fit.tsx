import { Fragment, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorOutlineRail } from '../src/renderer/components/editor/EditorOutlineRail';
import { nestHeadings } from '../src/renderer/components/editor/outline-rail-model';
import { scrollToOutlineAnchor } from '../src/renderer/components/editor/outline-scroll';
import { useSettingsStore } from '../src/renderer/store/settings-store';
import '../src/renderer/lib/i18n';
// The renderer entry's global sheets, in its order (src/renderer/main.tsx).
import '../src/styles/index.css';
import '../src/styles/materials.css';
import '../src/styles/comments-review.css';
import '../src/styles/desktop-shell.css';
import '../src/styles/ui-controls.css';
import '../src/styles/desktop-typography.css';

// A synthetic chapter: four H1s, each with two H2s and an H3, titles long
// enough to fill the label lane.
const headings = [1, 2, 3, 4].flatMap((part) => [
  { id: `h1-${part}`, level: 1 as const, text: `Part ${part}: the harbour lamps go out one by one` },
  { id: `h1-${part}-h2-1`, level: 2 as const, text: `${part}.1 a letter nobody signed` },
  { id: `h1-${part}-h2-2`, level: 2 as const, text: `${part}.2 the second key` },
  { id: `h1-${part}-h3`, level: 3 as const, text: `${part}.3 keep the tide table consistent` },
]);
const tree = nestHeadings(headings);
const ids = headings.map(({ id }) => id);
const prose = 'Synthetic prose for the outline rail fit check, set long enough to fill the paper column. '.repeat(6);

export function Fixture() {
  const [column, setColumn] = useState(1280);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    Object.assign(window, { __RAIL_FIT__: {
      setColumn,
      setOutlineRailMode: (mode: 'visible' | 'hidden') => useSettingsStore.getState().setOutlineRailMode(mode),
    } });
  }, []);
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div className="editor-shell" data-fixture="column" style={{ width: column, flex: 'none', height: '100vh' }}>
        <div className="editor-body">
          <EditorOutlineRail title="Synthetic outline" items={tree} scrollspyIds={ids}
            onItemClick={(id) => scrollToOutlineAnchor(id, scrollEl)} />
          <div className="editor-scroll" ref={setScrollEl}>
            <div className="editor__spread">
              <article className="page page--entity">
                <h1 className="page__title" data-fixture="text">Synthetic chapter with a title that runs long</h1>
                {headings.map(({ id, level, text }) => {
                  const Tag = (`h${level}`) as 'h1' | 'h2' | 'h3';
                  return (
                    <Fragment key={id}>
                      <Tag data-block-id={id} data-fixture="text">{text}</Tag>
                      <p data-fixture="text">{prose}</p>
                      <p data-fixture="text">{prose}</p>
                    </Fragment>
                  );
                })}
              </article>
            </div>
          </div>
        </div>
      </div>
      {/* Stands in for the side panels that take the rest of the window. */}
      <aside data-fixture="panels" style={{ flex: 1 }} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
