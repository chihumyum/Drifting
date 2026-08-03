import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function block(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('Project Dashboard scroll ownership', () => {
  it('constrains the dashboard to its editor pane while hiding only scrollbar chrome', () => {
    const dashboardView = source('src/renderer/views/ProjectDashboard.tsx');
    const dashboardCss = source('src/styles/dashboard.css');
    const doc = source('docs/design-system.md');
    const dash = block(dashboardCss, '.dash {', '.dash *,');
    const webkitScrollbar = block(dashboardCss, '.dash::-webkit-scrollbar {', '.dash__inner {');

    expect(dashboardView).toContain('<div className="dash">');
    expect(dash).toContain('width: 100%;');
    expect(dash).toContain('height: 100%;');
    expect(dash).toContain('min-height: 0;');
    expect(dash).toContain('overflow-y: auto;');
    expect(dash).toContain('scrollbar-width: none;');
    expect(webkitScrollbar).toContain('display: none;');
    expect(doc).toContain('隐藏的只是 scrollbar chrome，不是滚动能力');
  });
});
