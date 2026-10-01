import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const coreRoot = path.resolve(__dirname, '../../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(coreRoot, relativePath), 'utf8');
}

describe('sidebar text tabs', () => {
  it('keeps full labels on both sides without a compact representation', () => {
    for (const path of ['leftBars/LeftSidebarHeader.tsx', 'rightBars/RightSidebarHeader.tsx']) {
      const header = source(`src/renderer/components/${path}`);
      expect(header).not.toContain('ResizeObserver');
      expect(header).not.toContain('compact');
      expect(header).not.toContain('glyph=');
      expect(header).not.toContain('shortLabels');
      expect(header).toContain('typography="label"');
      expect(header).toContain('aria-label=');
    }
    expect(source('docs/design-system.md')).toContain('始终显示完整标题');
  });
});
