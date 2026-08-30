import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('desktop settings section navigation', () => {
  it('jumps directly while preserving scroll-spy for manual scrolling', () => {
    const settings = read('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    const css = read('src/styles/settings.css');
    const docs = read('docs/design-system.md');

    expect(settings).toContain('main.addEventListener(\'scroll\', onScroll');
    expect(settings).toContain('className="set-main set-main--instant-section-nav"');
    expect(settings.match(/behavior: 'auto'/g)).toHaveLength(2);
    expect(settings).not.toContain("behavior: 'smooth'");
    expect(css).toMatch(
      /\.set-main--instant-section-nav\s*\{[\s\S]*?scroll-behavior:\s*auto;/,
    );
    expect(docs).toContain(
      '桌面完整 Settings 左侧 Section 点击后直接定位到目标内容，不播放纵向滚动动画',
    );
  });
});
