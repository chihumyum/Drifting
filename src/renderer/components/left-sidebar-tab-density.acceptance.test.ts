import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const coreRoot = path.resolve(__dirname, '../../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(coreRoot, relativePath), 'utf8');
}

describe('left sidebar tab density', () => {
  it('renders either a glyph or a label according to the measured tab-row width', () => {
    const header = source('src/renderer/components/leftBars/LeftSidebarHeader.tsx');
    const doc = source('docs/design-system.md');

    expect(header).toContain('const FULL_TABS_MIN_WIDTH = 220;');
    expect(header).toContain('new ResizeObserver(measure)');
    expect(header).toContain('setCompact(el.clientWidth < FULL_TABS_MIN_WIDTH)');
    expect(header).toContain('title={compact ? label : statusTitle}');
    expect(header).toContain('aria-label={statusTitle ? `${label}: ${statusTitle}` : label}');
    expect(header).toMatch(
      /\{compact \? \([\s\S]*?<AgentCountBadge[\s\S]*?glyph && \([\s\S]*?\) : \(\s*<span/,
    );
    expect(header).not.toContain('{!compact && <span>{label}</span>}');
    expect(doc).toContain('任何宽度都不同时并排图标与文字');
  });
});
