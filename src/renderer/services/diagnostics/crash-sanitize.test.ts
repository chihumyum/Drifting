import { describe, expect, it } from 'vitest';
import { reportFingerprint, sanitizeReportText, sanitizeStack } from './crash-sanitize';

describe('crash report sanitizing', () => {
  it('redacts prose, long quotes and home paths but keeps identifiers', () => {
    expect(sanitizeReportText('Cannot restore node:0193-abc; the typed SQLite row does not exist')).toBe(
      'Cannot restore node:0193-abc; the typed SQLite row does not exist',
    );
    expect(sanitizeReportText('无法保存：他推开门的时候，雨已经停了，街上只剩下潮湿的灯光')).toBe('[text]');
    expect(sanitizeReportText('Unexpected token in "the quick brown fox jumps over the lazy dog again and again"'))
      .toBe('Unexpected token in "[text]"');
    // Built at runtime so the source holds no personal absolute path.
    const home = ['', 'Users', 'someone'].join('/');
    expect(sanitizeReportText(`open ${home}/Library/App/drifting.db failed`)).toBe(
      'open ~/Library/App/drifting.db failed',
    );
    expect(sanitizeReportText('x'.repeat(400))).toHaveLength(300);
  });

  it('keeps only frames and drops the message line', () => {
    const stack = [
      'TypeError: Cannot read properties of undefined (reading "他推开门的时候雨已经停了街上只剩下灯光")',
      '    at render (tauri://localhost/assets/index-Bx9fK2aQ.js:1:2345)',
      '    at commitRoot (tauri://localhost/assets/vendor-react-a1b2c3d4.js:9:10)',
    ].join('\n');
    expect(sanitizeStack(stack)).toBe(
      'at render (tauri://localhost/assets/index-Bx9fK2aQ.js:1:2345)\nat commitRoot (tauri://localhost/assets/vendor-react-a1b2c3d4.js:9:10)',
    );
  });

  it('groups the same failure across builds whose bundle hashes differ', () => {
    const a = reportFingerprint('renderer-error', 'TypeError', 'at render (tauri://localhost/assets/index-Bx9fK2aQ.js:1:2345)');
    const b = reportFingerprint('renderer-error', 'TypeError', 'at render (tauri://localhost/assets/index-Zz81Lmq0.js:1:2345)');
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9:._-]+$/);
  });
});
